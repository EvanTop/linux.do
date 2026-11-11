// ==UserScript==
// @name         linux.do 域名信息放大镜
// @namespace    yee.cx
// @version      1.0.0
// @description  在 linux.do（Discourse）帖子正文中自动识别外链域名，域名右侧显示放大镜图标，点击弹出该域名的基础信息（注册状态 / 注册商 / 注册时间 / 到期时间），数据来自 yee.cx
// @author       Evan
// @match        https://linux.do/*
// @grant        GM_xmlhttpRequest
// @connect      yee.cx
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  var API_ENRICH = 'https://yee.cx/api/enrich';
  var API_WHOIS = 'https://yee.cx/api/whois';
  var BASE_URL = 'https://yee.cx/';
  var CACHE = Object.create(null); // 域名 -> Promise

  var SKIP_HOSTS = { 'nodeloc.com': 1, 'sb.sb': 1, 'sb.sb.sb': 1, 'linux.sb': 1, 'n.ht': 1, 'nextbuf.com': 1, 'www.nextbuf.com': 1, 'linux.do': 1, 'www.linux.do': 1 }; // 站内/自家域名不插放大镜
  var SKIP_TLDS = { local: 1, localhost: 1, test: 1, invalid: 1, example: 1, lan: 1, internal: 1, onion: 1 };

  /* ---------------- 工具函数 ---------------- */

  function isPlainDomain(d) {
    if (!d) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) return false; // 纯 IP
    var parts = d.split('.');
    var tld = parts[parts.length - 1];
    if (SKIP_TLDS[tld]) return false;
    return true;
  }

  // 常见多级公共后缀表（多级公共后缀下的注册域，如 evan.com.cn 属于注册域而非子域）
  var PUBLIC_SUFFIXES = [
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    'com.ee', 'pri.ee', 'org.ee',
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
    'com.au', 'net.au', 'org.au',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
    'com.hk', 'com.tw', 'org.tw', 'com.kr', 'co.kr', 'or.kr',
    'com.sg', 'com.my', 'com.vn', 'co.nz', 'com.br', 'com.mx',
    'com.tr', 'com.co', 'co.in', 'ac.in', 'com.ph', 'com.ua',
    'com.pl', 'com.ru', 'com.ar', 'com.pe', 'co.id', 'com.th'
  ];

  // 匹配最长公共后缀（多级后缀优先，等价于从长到短尝试）
  function matchPublicSuffix(d) {
    var best = '';
    for (var i = 0; i < PUBLIC_SUFFIXES.length; i++) {
      var s = PUBLIC_SUFFIXES[i];
      if (s.length > best.length && d.slice(-(s.length + 1)) === '.' + s) best = s;
    }
    return best;
  }

  // 判断是否为真子域（不支持 yee.cx 查询）：
  // 域名去掉末尾公共后缀后，剩余标签恰好 1 个即为注册域（允许查询）；
  // 剩余标签 >1 才判定为真子域（如 demo.cocaapi.com 仍不支持查询）
  function isSubDomain(d) {
    if (!d) return false;
    var ps = matchPublicSuffix(d);
    var rest = ps ? d.slice(0, d.length - ps.length - 1) : d.slice(0, d.lastIndexOf('.'));
    if (!rest) return false;
    return rest.split('.').length > 1;
  }

  function normalizeDomain(d) {
    var v = String(d || '').toLowerCase();
    v = v.replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '').trim();
    if (v.indexOf('www.') === 0) v = v.slice(4);
    try {
      var host = new URL('http://' + v).hostname;
      if (host && host.indexOf('.') > 0) v = host;
    } catch (e) {}
    return v;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* ---------------- 放大镜图标 ---------------- */

  var MAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

  function makeMagnifier(domain) {
    var a = document.createElement('a');
    a.className = 'nlc-mag';
    a.href = 'javascript:void(0)';
    a.title = '查询域名信息：' + domain;
    a.setAttribute('data-nlc-domain', domain);
    a.innerHTML = MAG_SVG;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showPopup(domain, a);
    });
    return a;
  }

  /* ---------------- 小窗 ---------------- */

  var activePopup = null;

  function closePopup() {
    if (activePopup) {
      if (activePopup.parentNode) activePopup.parentNode.removeChild(activePopup);
      activePopup = null;
    }
    document.removeEventListener('keydown', onDocKey);
  }

  function onDocKey(e) {
    if (e.key === 'Escape') closePopup();
  }

  function showPopup(domain, anchor) {
    closePopup();
    var pop = document.createElement('div');
    pop.className = 'nlc-pop';

    var head = document.createElement('div');
    head.className = 'nlc-pop-head';
    var title = document.createElement('span');
    title.className = 'nlc-pop-title';
    title.textContent = domain;
    var closeBtn = document.createElement('button');
    closeBtn.className = 'nlc-pop-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closePopup);
    head.appendChild(title);
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'nlc-pop-body';
    body.innerHTML = '<div class="nlc-loading"><span class="nlc-spinner"></span>加载中…</div>';

    var foot = document.createElement('div');
    foot.className = 'nlc-pop-foot';
    var moreLabel = document.createTextNode('更多信息 ');
    var more = document.createElement('a');
    more.className = 'nlc-pop-more';
    more.href = BASE_URL + encodeURIComponent(domain);
    more.target = '_blank';
    more.rel = 'noopener';
    more.textContent = BASE_URL + domain;
    foot.appendChild(moreLabel);
    foot.appendChild(more);

    pop.appendChild(head);
    pop.appendChild(body);
    pop.appendChild(foot);
    document.body.appendChild(pop);

    // 定位：图标下方，视口溢出则翻转
    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    var left = r.left;
    var maxLeft = window.innerWidth - pw - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
    if (top < 8) top = 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    activePopup = pop;
    document.addEventListener('keydown', onDocKey);

    if (isSubDomain(domain)) {
      body.innerHTML = '<div class="nlc-err">不支持二级域名查询</div>';
    } else {
      fetchEnrich(domain).then(function (data) {
        if (activePopup !== pop) return;
        renderBody(body, domain, data);
      }).catch(function (err) {
        if (activePopup !== pop) return;
        // 降级：enrich 失败后尝试 whois 原始数据
        fetchWhois(domain).then(function (raw) {
          if (activePopup !== pop) return;
          var w = parseWhoisRaw(raw);
          var lower = String(raw).toLowerCase();
          var isFree = /no match|not found|no data found|domain not found/.test(lower);
          var state = isFree ? '未注册（可注册）' : '已注册';
          if (w.registrar || w.registered || w.expires) {
            var rows = [
              ['域名状态', state],
              ['注册商', w.registrar || '—'],
              ['注册时间', w.registered || '—'],
              ['到期时间', w.expires || '—']
            ];
            var html = '<div class="nlc-row"><span class="nlc-label">域名</span><span class="nlc-value">' + esc(domain) + '</span></div>';
            rows.forEach(function (r) {
              html += '<div class="nlc-row"><span class="nlc-label">' + esc(r[0]) + '</span><span class="nlc-value">' + esc(r[1]) + '</span></div>';
            });
            body.innerHTML = html;
          } else {
            body.innerHTML = '<div class="nlc-err">查询失败</div>';
          }
        }).catch(function (e2) {
          if (activePopup !== pop) return;
          body.innerHTML = '<div class="nlc-err">查询失败</div>';
          if (e2) console.error('[nlc-magnifier]', domain, e2);
        });
        if (err) console.error('[nlc-magnifier]', domain, err);
      });
    }

    setTimeout(function () {
      document.addEventListener('click', function once(e) {
        if (!activePopup || !activePopup.contains(e.target) && !(e.target.closest && e.target.closest('.nlc-mag'))) {
          closePopup();
        }
        document.removeEventListener('click', once);
      });
    }, 0);
  }

  function fetchEnrich(domain) {
    if (CACHE[domain]) return CACHE[domain];
    CACHE[domain] = new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_ENRICH,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ domain: domain }),
        timeout: 12000,
        onload: function (res) {
          var d;
          try { d = JSON.parse(res.responseText); } catch (e) { reject(e); return; }
          if (d && d.success && d.data) resolve(d.data);
          else reject(new Error((d && d.error) || 'empty response'));
        },
        onerror: reject,
        ontimeout: function () { reject(new Error('timeout')); }
      });
    });
    return CACHE[domain];
  }

  // 降级：whois 原始数据接口
  function fetchWhois(domain) {
    var key = 'whois:' + domain;
    if (CACHE[key]) return CACHE[key];
    CACHE[key] = new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_WHOIS,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ domain: domain }),
        timeout: 12000,
        onload: function (res) {
          var d;
          try { d = JSON.parse(res.responseText); } catch (e) { reject(e); return; }
          if (d && d.success && d.data && d.data.raw) resolve(d.data.raw);
          else reject(new Error((d && d.error) || 'empty whois response'));
        },
        onerror: reject,
        ontimeout: function () { reject(new Error('timeout')); }
      });
    });
    return CACHE[key];
  }

  // 解析 whois 原始文本，提取注册商 / 注册时间 / 到期时间（日期取前 10 位）
  function parseWhoisRaw(raw) {
    var text = raw || '';
    var out = { registrar: '', registered: '', expires: '' };
    var m;
    m = text.match(/^registrar:\s*(.+)$/im);
    if (m) out.registrar = m[1].trim();
    m = text.match(/^(?:creation\s*date|registry\s*creation\s*date):\s*(\S+)/im);
    if (m) out.registered = String(m[1]).slice(0, 10);
    m = text.match(/^(?:registry\s*expiry\s*date|expiry\s*date):\s*(\S+)/im);
    if (m) out.expires = String(m[1]).slice(0, 10);
    return out;
  }

  function renderBody(body, domain, data) {
    var p = (data && data.parsed) || {};
    var state = '未知';
    if (data.type === 0) state = '未注册（可注册）';
    else if (data.type === 1) state = '已注册';

    function d10(v) { return v ? String(v).slice(0, 10) : '—'; }

    var rows = [
      ['域名状态', state],
      ['注册商', (p.registrar && p.registrar.name) || '—'],
      ['注册时间', d10(p.registered)],
      ['到期时间', d10(p.expires)]
    ];

    var html = '<div class="nlc-row"><span class="nlc-label">域名</span><span class="nlc-value">' + esc(domain) + '</span></div>';
    rows.forEach(function (r) {
      html += '<div class="nlc-row"><span class="nlc-label">' + esc(r[0]) + '</span><span class="nlc-value">' + esc(r[1]) + '</span></div>';
    });
    body.innerHTML = html;
  }

  /* ---------------- 正文扫描 ---------------- */

  var DOMAIN_RE = /(^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?=$|[^a-z0-9_.-])/gi;

  // 单个链接：外部绝对 URL，在其后插放大镜（由调用方限定扫描区域）
  // linux.sb 会把外链改写成 https://linux.sb/jump?to=<urlencode(目标URL)>&sig=...，需从 to 参数还原真实域名
  function handleAnchor(a) {
    if (a.dataset.nlcDone) return;
    var href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    var url = null;
    var host = '';
    try { url = new URL(href, location.href); host = url.hostname.toLowerCase(); } catch (e) { return; }
    // 站内跳转包装：解析 jump?to= 还原真实目标域名后再判断（to 参数为 urlencode 后的目标 URL）
    if (SKIP_HOSTS[host] && url.pathname === '/jump') {
      var to = url.searchParams ? url.searchParams.get('to') : '';
      if (to) {
        try {
          var real = new URL(to, location.href);
          if ((real.protocol === 'http:' || real.protocol === 'https:') && real.hostname) {
            host = real.hostname.toLowerCase();
          }
        } catch (e) {}
      }
    }
    if (SKIP_HOSTS[host]) return;
    var dom = normalizeDomain(host);
    if (!isPlainDomain(dom)) return;
    a.dataset.nlcDone = '1';
    var mag = makeMagnifier(dom);
    a.parentNode.insertBefore(mag, a.nextSibling);
  }

  // Discourse 干扰区：引用框、onebox 预览卡、代码块、图片灯箱、用户卡片
  var EXCLUDE_IN = 'aside.quote,aside.onebox,blockquote,pre,code,.user-card,.lightbox-wrapper,.onebox,.d-editor-preview';
  // Discourse 站内功能链接的类名
  var SKIP_CLASS = { 'mention': 1, 'hashtag': 1, 'hashtag-cooked': 1, 'lightbox': 1, 'show-more': 1, 'github-onebox__repo': 1 };

  // 区域内链接：仅处理外部 http(s) 链接，跳过站内提及/标签、灯箱、onebox 等
  function handleLinks(scope) {
    var anchors = scope.querySelectorAll ? scope.querySelectorAll('a[href]') : [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.dataset.nlcDone) continue;
      if (a.classList) {
        var skip = false;
        for (var k in SKIP_CLASS) { if (a.classList.contains(k)) { skip = true; break; } }
        if (skip) continue;
        if (a.classList.contains('nlc-mag')) continue;
      }
      if (a.closest && a.closest(EXCLUDE_IN)) continue;
      if (a.closest && a.closest('.nlc-pop')) continue;
      handleAnchor(a);
    }
  }

  // 文本节点：匹配域名，拆分为 [前文][域名span][放大镜][后文]
  function handleTextNode(node) {
    // 双保险：脚本自己插入的域名 span / 放大镜内部不再处理，避免重复扫描时叠加
    if (node.parentNode && node.parentNode.closest &&
        node.parentNode.closest('.nlc-dom,.nlc-mag')) return;
    var text = node.nodeValue;
    if (!text || !/\./.test(text)) return;
    DOMAIN_RE.lastIndex = 0;
    var m;
    var hits = [];
    while ((m = DOMAIN_RE.exec(text))) {
      var dom = normalizeDomain(m[2]);
      if (!isPlainDomain(dom) || SKIP_HOSTS[dom]) continue;
      var domStart = m.index + m[0].indexOf(m[2]);
      hits.push({ dom: dom, start: domStart, len: m[2].length });
    }
    if (!hits.length) return;

    var frag = document.createDocumentFragment();
    var pos = 0;
    hits.forEach(function (h) {
      if (h.start < pos) return; // 防重叠
      frag.appendChild(document.createTextNode(text.slice(pos, h.start)));
      var span = document.createElement('span');
      span.className = 'nlc-dom';
      span.setAttribute('data-nlc-domain', h.dom);
      span.textContent = text.substr(h.start, h.len);
      frag.appendChild(span);
      frag.appendChild(makeMagnifier(h.dom));
      pos = h.start + h.len;
    });
    frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  // 文本兜底扫描：遍历区域内文本节点（跳过 a / pre / code / script / style）
  function scanTextTree(root) {
    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (n) {
          // 引用框 / onebox / 用户卡片 / 编辑器预览内的文本一律不处理
          if (n.parentNode && n.parentNode.closest &&
              n.parentNode.closest('aside.quote,aside.onebox,blockquote,.user-card,.lightbox-wrapper,.d-editor-preview')) {
            return NodeFilter.FILTER_REJECT;
          }
          var p = n.parentNode;
          while (p && p !== root) {
            if (p.tagName === 'A' || p.tagName === 'PRE' || p.tagName === 'CODE' ||
                p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'TEXTAREA' ||
                p.classList && (p.classList.contains('nlc-mag') || p.classList.contains('nlc-dom') ||
                  p.classList.contains('onebox') || p.classList.contains('onebox-body') ||
                  p.classList.contains('nb-md-preview-pane'))) {
              return NodeFilter.FILTER_REJECT;
            }
            p = p.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var j = 0; j < nodes.length; j++) handleTextNode(nodes[j]);
  }

  // 正文容器：Discourse 主楼 #post_1 与回帖共用 .cooked
  // 排除：编辑器实时预览 .d-editor-preview、引用框、onebox
  function scanCooked(scope) {
    handleLinks(scope);
    scanTextTree(scope);
  }

  function scanAll() {
    var list = document.querySelectorAll('.cooked');
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.closest && c.closest('.d-editor-preview')) continue;
      if (c.closest && c.closest('.nlc-pop')) continue;
      // 幂等：已处理的链接有 data-nlc-done，已拆分的文本节点不含域名，重扫不会重复注入
      scanCooked(c);
    }
  }

  // Ember 渲染 + 滚动懒加载（占位符 .post-stream--cloaked 被替换为真实楼层）都会新增 .cooked
  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = null; scanAll(); }, 200);
  }

  /* ---------------- 注入与监听 ---------------- */

  function injectStyles() {
    if (document.getElementById('nlc-style')) return;
    var css = [
      /* 放大镜：尺寸贴合 Discourse 16px 正文，颜色走站点灰阶，hover 用主色 */
      '.nlc-mag{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin:0 1px 0 2px;vertical-align:-2px;color:var(--primary-low-mid,#a5a5a5);cursor:pointer;border-radius:var(--d-border-radius,4px);text-decoration:none;opacity:.9;transition:color .12s ease,background .12s ease}',
      '.nlc-mag:hover{color:var(--tertiary,#0088cc);background:var(--primary-very-low,#f5f5f5);opacity:1}',
      '.nlc-mag svg{display:block}',
      /* 弹窗：Discourse 无卡片阴影，靠 --primary-low 边框与 --secondary 底色分层，圆角 4px */
      '.nlc-pop{position:fixed;z-index:2147483646;width:290px;max-width:calc(100vw - 24px);background:var(--secondary,#ffffff);color:var(--primary,#222222);border:1px solid var(--primary-low,#e9e9e9);border-radius:var(--d-border-radius,4px);box-shadow:0 8px 24px rgba(0,0,0,.14);font-family:var(--font-family,Inter,Arial,"PingFang SC",sans-serif);font-size:13px;line-height:1.6;overflow:hidden}',
      '.nlc-pop-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--primary-low,#e9e9e9);background:var(--primary-very-low,#f7f7f7)}',
      '.nlc-pop-title{font-size:13.5px;font-weight:600;color:var(--primary,#222222);word-break:break-all;padding-right:8px;min-width:0}',
      '.nlc-pop-close{display:flex;align-items:center;justify-content:center;padding:0!important;margin:0!important;line-height:1!important;font-size:18px!important;width:22px!important;height:22px!important;flex:0 0 auto!important;border:0!important;background:transparent;color:var(--primary-medium,#909090);cursor:pointer;border-radius:var(--d-border-radius,4px);transition:color .12s,background .12s}',
      '.nlc-pop-close:hover{color:var(--primary,#222222);background:var(--primary-low,#e9e9e9)}',
      '.nlc-pop-body{padding:6px 12px}',
      '.nlc-row{display:flex;gap:10px;padding:4px 0;border-bottom:1px dashed var(--primary-low,#e9e9e9)}',
      '.nlc-row:last-child{border-bottom:0}',
      '.nlc-label{flex:0 0 58px;color:var(--primary-medium,#909090);white-space:nowrap}',
      '.nlc-value{color:var(--primary,#222222);word-break:break-all;min-width:0}',
      '.nlc-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 0;color:var(--primary-medium,#909090);text-align:center}',
      '.nlc-spinner{display:inline-block;width:15px;height:15px;flex:0 0 auto;border:2px solid var(--primary-low,#e9e9e9);border-top-color:var(--tertiary,#0088cc);border-radius:50%;animation:nlc-spin .8s linear infinite!important}',
      '@keyframes nlc-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '.nlc-err{padding:10px 0;color:var(--danger,#c80001);text-align:center}',
      /* 底栏：与站点次面板同色，左对齐单行省略 */
      '.nlc-pop-foot{padding:7px 12px 9px;border-top:1px solid var(--primary-low,#e9e9e9);background:var(--primary-very-low,#f7f7f7);text-align:left;display:flex;align-items:center;justify-content:flex-start;gap:5px;color:var(--primary-medium,#909090);font-size:13px;white-space:nowrap;overflow:hidden}',
      '.nlc-pop-more{color:var(--tertiary,#0088cc);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}',
      '.nlc-pop-more:hover{text-decoration:underline}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'nlc-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function init() {
    injectStyles();
    scanAll();
    // Discourse 为 Ember 客户端渲染 + 滚动懒加载，且站内跳转不刷新页面
    var observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
