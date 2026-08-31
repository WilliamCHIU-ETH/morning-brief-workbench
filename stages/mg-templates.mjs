/**
 * 全幅 MG 版型庫。
 *
 * 這四個版型是從 0821 鼎元 V4c 手寫的四格反推出來的——那四格不是四個獨立作品，
 * 是四種反覆出現的資訊形狀：
 *
 *   stat-compare  兩項數據對照（02 台股／道瓊）
 *   chain         因果鏈接三節加結論帶（04 需求從哪裡來）
 *   gap           已發生 vs 未發生的時間軸落差（06 時間差）
 *   checklist     編號清單（08 今日觀察兩件事）
 *
 * 幾何值一律沿用 V4c 實際過關的那組，不重新設計：
 *  - 內容全部放進 #stage（x=48 y=254 984x1096），由 comp-shell 的幾何強制避開
 *    標題板（y<254）與字幕框／關鍵數字禁區（y>1350）。
 *  - shiftY 是各版型在 #inner 上的垂直位移，V4c 實測值：02→24、04→74、06→34、08→44。
 *
 * 每個版型宣告 `required` 與 `defaults`。抽取不到的欄位用 defaults 補，
 * 所以一定產得出合法 composition；要更好的文案就用 mg-overrides.json 覆寫。
 */

export const TEMPLATES = {
  // ── 兩項數據對照 ─────────────────────────────────────────────────────────
  'stat-compare': {
    shiftY: 24,
    required: ['title', 'items'],
    defaults: { title: '數據對照' },
    validate(d) {
      if (!Array.isArray(d.items) || d.items.length !== 2) {
        return 'stat-compare 需要正好 2 筆 items（版面是上下等高分割，第三筆放不進 984x1096）';
      }
      for (const it of d.items) {
        if (!it.label || it.value === undefined) return 'items 每筆需要 label 與 value';
      }
      return null;
    },
    render(C, d) {
      const [a, b] = d.items;
      const col = (it) => (it.dir === 'down' ? C.down : C.up);
      const css = `
#m-title{left:0;top:0}
.blk{position:absolute;left:0;width:984px;height:404px;border-radius:28px;background:${C.bg2}}
#m-up{top:112px;border:5px solid ${col(a)}}
#m-dn{top:568px;border:5px solid ${col(b)}}
.blk .lb{position:absolute;left:40px;top:30px;font-size:46px;font-weight:700;color:${C.sub};line-height:1}
.blk .row{position:absolute;left:40px;top:106px;display:flex;align-items:baseline;gap:16px}
.blk .num{font-size:140px;font-weight:700;line-height:1}
.blk .u{font-size:54px;font-weight:700;line-height:1}
.blk .sub{position:absolute;left:40px;top:302px;font-size:40px;color:${C.sub};line-height:1}
#m-line{position:absolute;left:242px;top:538px;width:500px;height:5px;background:${C.line};border-radius:3px}
`;
      const blk = (id, nid, it) => `      <div class="blk" id="${id}">
        <div class="lb">${it.label}</div>
        <div class="row"><span class="num" id="${nid}" style="color:${col(it)}">0</span><span class="u" style="color:${col(it)}">${it.unit ?? ''}</span></div>
        ${it.sub ? `<div class="sub">${it.sub}</div>` : ''}
      </div>`;
      const body = `      <div class="t h1" id="m-title">${d.title}</div>
${blk('m-up', 'm-n1', a)}
      <div id="m-line"></div>
${blk('m-dn', 'm-n2', b)}
`;
      const fmt = (it) => (it.dir === 'down' ? 'minus' : 'plus');
      const tl = (dur) => `
  const plus=(v)=>'+'+Math.round(v);
  const minus=(v)=>'\\u2212'+Math.round(v);
  tl.fromTo('#m-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.38,ease:'power3.out'},0);
  tl.fromTo('#m-up',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},.36);
  countUp('#m-n1',${a.value},.62,.9,${fmt(a)});
  tl.fromTo('#m-line',{scaleX:0,autoAlpha:0},{scaleX:1,autoAlpha:1,duration:.3,ease:'power2.out'},1.72);
  tl.fromTo('#m-dn',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},2.02);
  countUp('#m-n2',${b.value},2.28,1.0,${fmt(b)});
  tl.to('#m-up',{autoAlpha:.7,duration:.4,ease:'power2.out'},2.28);
  tl.to('#m-title,#m-up,#m-line,#m-dn',{y:-30,duration:.5,ease:'power2.in'},${(dur - 0.6).toFixed(2)});
`;
      return { css, body, tl };
    },
  },

  // ── 因果鏈 ───────────────────────────────────────────────────────────────
  chain: {
    shiftY: 74,
    required: ['title', 'nodes', 'band'],
    defaults: { title: '傳導路徑', band: '' },
    validate(d) {
      if (!Array.isArray(d.nodes) || d.nodes.length < 1 || d.nodes.length > 3) {
        return 'chain 需要 1～3 個 nodes（節點寬 300px、間距 42px，超過 3 個放不進 984px 舞台）';
      }
      return null;
    },
    // N 個節點在 984px 舞台上置中：totalWidth = N*300 + (N-1)*42，
    // 少於 3 節時不再用「—」佔位——那格是空的，一眼就看得出「這格資料沒抽到東西」。
    // 1／2 節版沿用同一組留白幾何（見 ROLE.md「這份文件是拿來改的」精神：只改必要的量）。
    render(C, d) {
      const N = d.nodes.length;
      const totalWidth = N * 300 + (N - 1) * 42;
      const margin = (984 - totalWidth) / 2;
      const nodeLeft = (i) => margin + i * 342;
      const nodeDelay = (i) => 0.34 + i * 0.52;
      const lastEnter = nodeDelay(N - 1);
      const highlightAt = lastEnter + 0.72;
      const lastId = `d-n${N}`;
      const lastTextId = `d-n${N}t`;

      const nodeCss = Array.from({ length: N }, (_, i) =>
        `#d-n${i + 1}{left:${nodeLeft(i)}px}`).join('\n');
      const arrowCss = Array.from({ length: N - 1 }, (_, i) =>
        `#d-a${i + 1}{left:${nodeLeft(i) + 306}px}`).join('\n');
      const css = `
#d-title{left:0;top:0}
.node{position:absolute;top:290px;width:300px;height:250px;border-radius:26px;background:${C.bg2};border:5px solid ${C.line};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 20px;overflow:hidden}
.node span{display:block;min-width:0;max-width:260px;font-size:54px;font-weight:700;color:${C.sub};line-height:1.25;word-break:break-word}
${nodeCss}
.arw{position:absolute;top:400px;width:30px;height:30px;border-top:6px solid ${C.line};border-right:6px solid ${C.line};transform:rotate(45deg)}
${arrowCss}
#d-band{position:absolute;left:0;top:660px;width:984px;height:150px;border-radius:26px;background:${C.upFill};display:flex;align-items:center;justify-content:center}
#d-band span{font-size:64px;font-weight:700}
`;
      const nodeBody = d.nodes.map((n, i) => {
        const id = `d-n${i + 1}`;
        const isLast = i === N - 1;
        const span = isLast ? `<span id="${lastTextId}">${n}</span>` : `<span>${n}</span>`;
        return `      <div class="node" id="${id}">${span}</div>`;
      }).join('\n');
      const arrowBody = Array.from({ length: N - 1 }, (_, i) =>
        `      <div class="arw" id="d-a${i + 1}"></div>`).join('\n');
      // 依原文順序交錯節點與箭頭（node, arw, node, arw, node…）。
      const bodyParts = [];
      for (let i = 0; i < N; i++) {
        bodyParts.push(nodeBody.split('\n')[i]);
        if (i < N - 1) bodyParts.push(arrowBody.split('\n')[i]);
      }
      const body = `      <div class="t h1" id="d-title">${d.title}</div>
${bodyParts.join('\n')}
      ${d.band ? `<div id="d-band"><span>${d.band}</span></div>` : ''}
`;
      const nodeTl = Array.from({ length: N }, (_, i) =>
        `  tl.fromTo('#d-n${i + 1}',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},${nodeDelay(i).toFixed(2)});`).join('\n');
      const arrowTl = Array.from({ length: N - 1 }, (_, i) =>
        `  tl.fromTo('#d-a${i + 1}',{autoAlpha:0},{autoAlpha:1,duration:.24,ease:'power2.out'},${(nodeDelay(i) + 0.32).toFixed(2)});`).join('\n');
      const allIds = [
        'd-title',
        ...Array.from({ length: N }, (_, i) => `d-n${i + 1}`),
        ...Array.from({ length: N - 1 }, (_, i) => `d-a${i + 1}`),
      ];
      const tl = (dur) => `
  tl.fromTo('#d-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.38,ease:'power3.out'},0);
${nodeTl}
${arrowTl}
  tl.to('#${lastId}',{borderColor:'${C.hi}',duration:.34,ease:'power2.out'},${highlightAt.toFixed(2)});
  tl.to('#${lastTextId}',{color:'${C.hi}',duration:.34,ease:'power2.out'},${highlightAt.toFixed(2)});
${d.band ? `  tl.fromTo('#d-band',{y:40,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},${(highlightAt + 0.5).toFixed(2)});` : ''}
  tl.to('${allIds.map((id) => `#${id}`).join(',')}${d.band ? ',#d-band' : ''}',{autoAlpha:0,duration:.45,ease:'power2.in'},${(dur - 0.5).toFixed(2)});
`;
      return { css, body, tl };
    },
  },

  // ── 已發生 vs 未發生 ─────────────────────────────────────────────────────
  gap: {
    shiftY: 34,
    required: ['title', 'lead', 'left', 'right', 'gapLabel'],
    defaults: { title: '時間差', lead: '', gapLabel: '還沒發生', right: { label: '尚未發生' } },
    validate(d) {
      if (!d.left || d.left.value === undefined) return 'gap 的 left 需要 label 與 value（已發生的那一端要有數字）';
      return null;
    },
    render(C, d) {
      const css = `
#g-title{left:0;top:0}
#g-lead{position:absolute;left:0;top:108px;font-size:52px;font-weight:700;color:${C.hi}}
#g-axis{position:absolute;left:56px;top:640px;width:872px;height:6px;background:${C.line};border-radius:3px}
#g-d1{position:absolute;left:34px;top:614px;width:58px;height:58px;border-radius:50%;background:${C.upFill}}
#g-d2{position:absolute;left:892px;top:614px;width:58px;height:58px;border-radius:50%;border:6px solid ${C.line};background:${C.bg}}
#g-l1{position:absolute;left:0;top:700px;width:440px;height:190px}
#g-l1 .k{position:absolute;left:0;top:0;font-size:44px;font-weight:700;color:${C.up};line-height:1}
#g-l1 .n{position:absolute;left:0;top:66px;font-size:104px;font-weight:700;color:${C.up};line-height:1.1}
#g-l2{position:absolute;right:0;top:706px;width:360px;text-align:right;font-size:48px;font-weight:700;color:${C.sub}}
#g-gap{position:absolute;left:242px;top:476px;width:500px;text-align:center;font-size:64px;font-weight:700;color:${C.sub}}
`;
      const body = `      <div class="t h1" id="g-title">${d.title}</div>
      ${d.lead ? `<div id="g-lead">${d.lead}</div>` : ''}
      <div id="g-gap">${d.gapLabel}</div>
      <div id="g-axis"></div>
      <div id="g-d1"></div>
      <div id="g-d2"></div>
      <div id="g-l1"><div class="k">${d.left.label}</div><div class="n"><span id="g-num">0</span> ${d.left.unit ?? ''}</div></div>
      <div id="g-l2">${d.right.label}</div>
`;
      const tl = () => `
  tl.fromTo('#g-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},0);
${d.lead ? `  tl.fromTo('#g-lead',{autoAlpha:0},{autoAlpha:1,duration:.3,ease:'power2.out'},.3);` : ''}
  tl.fromTo('#g-axis',{scaleX:0,transformOrigin:'0% 50%'},{scaleX:1,duration:.5,ease:'power2.out'},.6);
  tl.fromTo('#g-d1',{scale:.4,autoAlpha:0},{scale:1,autoAlpha:1,duration:.34,ease:'back.out(1.6)'},.7);
  tl.fromTo('#g-l1',{y:20,autoAlpha:0},{y:0,autoAlpha:1,duration:.32,ease:'power2.out'},.86);
  countUp('#g-num',${d.left.value},.94,.7,int);
  tl.fromTo('#g-d2',{scale:.4,autoAlpha:0},{scale:1,autoAlpha:1,duration:.32,ease:'back.out(1.5)'},1.86);
  tl.fromTo('#g-l2',{y:20,autoAlpha:0},{y:0,autoAlpha:1,duration:.3,ease:'power2.out'},2.0);
  tl.fromTo('#g-gap',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.4,ease:'power3.out'},2.7);
`;
      return { css, body, tl };
    },
  },

  // ── 編號清單 ─────────────────────────────────────────────────────────────
  checklist: {
    shiftY: 44,
    required: ['title', 'lead', 'rows'],
    defaults: { title: '今日觀察', lead: '' },
    validate(d) {
      if (!Array.isArray(d.rows) || d.rows.length !== 2) {
        return 'checklist 需要正好 2 個 rows（列高 190px、上下留白，第三列會壓到字幕禁區）';
      }
      return null;
    },
    render(C, d) {
      const css = `
#w-title{left:0;top:0}
#w-lead{position:absolute;left:0;top:112px;font-size:56px;font-weight:700}
.wrow{position:absolute;left:0;width:984px;height:190px;border-radius:26px;background:${C.bg2};border:5px solid ${C.line};display:flex;align-items:center;gap:34px;padding:0 40px}
#w-r1{top:330px}
#w-r2{top:566px}
.wbox{flex:0 0 auto;width:64px;height:64px;border:6px solid ${C.line};border-radius:10px}
.wtx{font-size:54px;font-weight:700;line-height:1.2}
`;
      const row = (id, text) =>
        `      <div class="wrow" id="${id}"><div class="wbox"></div><div class="wtx">${text}</div></div>`;
      const body = `      <div class="t h1" id="w-title">${d.title}</div>
      ${d.lead ? `<div id="w-lead">${d.lead}</div>` : ''}
${row('w-r1', d.rows[0])}
${row('w-r2', d.rows[1])}
`;
      const tl = (dur) => `
  tl.fromTo('#w-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},0);
${d.lead ? `  tl.fromTo('#w-lead',{autoAlpha:0},{autoAlpha:1,duration:.32,ease:'power2.out'},.32);` : ''}
  tl.fromTo('#w-r1',{x:-40,autoAlpha:0},{x:0,autoAlpha:1,duration:.42,ease:'power3.out'},.7);
  tl.fromTo('#w-r2',{x:-40,autoAlpha:0},{x:0,autoAlpha:1,duration:.42,ease:'power3.out'},1.4);
  tl.to('#w-title,#w-lead,#w-r1,#w-r2',{y:26,duration:.5,ease:'power2.in'},${(dur - 0.6).toFixed(2)});
`;
      return { css, body, tl };
    },
  },

  // ── 建構卡（build + focus-dim）──────────────────────────────────────────────
  // 2026-08-30 從 cmchipk 題材片 Db7CHk2pope 學來的兩招（docs/editing-techniques.md #3、#4）：
  // 資料一格一格長出來、正在講的那格亮、講過的降灰。對標的三大法人系列也是用設計卡
  // 而不是 App 頁放法人數字（docs/screenshot-standard.md #9）——App 法人頁的口徑與晨報稿
  // 對不上（-170.1 vs -163.8），卡片直接放講稿的數字，對題性反而比截圖強。
  //
  // 每筆 item 的 at 是「該格亮起的秒數」，以素材格在 ledger 上的起點為 0。plan-mg 會把
  // 主播念到 atText 的逐字時間換成 at；沒有 ASR 時（付費前）就用 defaults 等距排。
  // opts.lead 是共享 resolver 算出的逐格 actualLead；composition 提前開始多少，關鍵幀就加多少。
  card: {
    shiftY: 0,
    required: ['title', 'items'],
    defaults: { title: '' },
    validate(d) {
      if (!Array.isArray(d.items) || d.items.length < 2 || d.items.length > 3) {
        return 'card 需要 2～3 筆 items（每格 300px 高，第四格會壓到字幕禁區）';
      }
      for (const it of d.items) {
        if (!it.label || it.value === undefined) return 'items 每筆需要 label 與 value';
        if (it.at !== undefined && !(Number.isFinite(it.at) && it.at >= 0)) return 'items 的 at 必須是 >=0 的秒數';
      }
      return null;
    },
    render(C, d, opts = {}) {
      const lead = Number(opts.lead) > 0 ? Number(opts.lead) : 0;
      const N = d.items.length;
      const rowH = 300, gap = 28, top0 = d.title ? 128 : 24;
      // 兩格只佔舞台上半（756/1096px），下半空著像沒排完；整塊往舞台光學中心放（略偏上 40px）。
      const blockH = top0 + N * rowH + (N - 1) * gap;
      const off = Math.max(0, Math.round((1096 - blockH) / 2) - 40);
      const tone = (it) => (it.tone === 'down' ? C.down : it.tone === 'up' ? C.up : C.text);
      const css = `
#k-title{position:absolute;left:0;top:${off}px;display:flex;align-items:center;gap:22px;font-size:56px;font-weight:700;line-height:1.15}
#k-title i{display:block;width:12px;height:60px;border-radius:6px;background:${C.hi}}
.krow{position:absolute;left:0;width:984px;height:${rowH}px;border-radius:28px;background:${C.bg2};border:5px solid ${C.line};padding:34px 44px}
.krow .kl{font-size:40px;font-weight:700;color:${C.sub};line-height:1}
.krow .kv{position:absolute;left:44px;top:104px;display:flex;align-items:baseline;gap:14px}
.krow .kn{font-size:132px;font-weight:700;line-height:1;letter-spacing:-.01em}
.krow .ku{font-size:52px;font-weight:700;line-height:1}
.krow .kp{position:absolute;right:44px;top:40px;padding:10px 24px;border-radius:999px;background:${C.hi};color:${C.bg};font-size:34px;font-weight:700;line-height:1.1}
${d.items.map((_, i) => `#k-r${i + 1}{top:${off + top0 + i * (rowH + gap)}px}`).join('\n')}
`;
      const row = (it, i) => `      <div class="krow" id="k-r${i + 1}">
        <div class="kl">${it.label}</div>
        <div class="kv"><span class="kn" id="k-n${i + 1}" style="color:${tone(it)}">${it.value}</span><span class="ku" style="color:${tone(it)}">${it.unit ?? ''}</span></div>
        ${it.note ? `<div class="kp" id="k-p${i + 1}">${it.note}</div>` : ''}
      </div>`;
      const body = `${d.title ? `      <div id="k-title"><i></i><span>${d.title}</span></div>\n` : ''}${d.items.map(row).join('\n')}
`;
      const tl = (dur) => {
        // dur 是含前導的渲染長度；at 仍以 nominal 起點為 0，所以加逐格 actualLead。
        // 沒給 at 的格在 nominal 前 60% 等距排，不能把 lead 又算進內容長度。
        const nominalDur = Math.max(0, dur - lead);
        const ats = d.items.map((it, i) => Number.isFinite(it.at)
          ? it.at + lead
          : lead + 0.4 + (nominalDur * 0.6) * i / N);
        const lines = [];
        // 標題在 composition 一開始就進（前導期就是給它用的），不要留一段全黑的空舞台。
        if (d.title) lines.push(`  tl.fromTo('#k-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},0);`);
        d.items.forEach((it, i) => {
          const at = ats[i].toFixed(2);
          // 先以 45% 亮度進場（畫面先於聲音），念到時再全亮＋黃框；前一格同時降灰。
          lines.push(`  tl.fromTo('#k-r${i + 1}',{y:26,autoAlpha:0},{y:0,autoAlpha:.45,duration:.42,ease:'power3.out'},${Math.max(0, ats[i] - 0.5).toFixed(2)});`);
          lines.push(`  tl.to('#k-r${i + 1}',{autoAlpha:1,borderColor:'${C.hi}',duration:.3,ease:'power2.out'},${at});`);
          if (it.note) lines.push(`  tl.fromTo('#k-p${i + 1}',{scale:.6,autoAlpha:0},{scale:1,autoAlpha:1,duration:.3,ease:'back.out(1.7)'},${(ats[i] + 0.25).toFixed(2)});`);
          if (i > 0) lines.push(`  tl.to('#k-r${i}',{autoAlpha:.5,borderColor:'${C.line}',duration:.4,ease:'power2.out'},${at});`);
        });
        lines.push(`  tl.to('${d.title ? '#k-title,' : ''}${d.items.map((_, i) => `#k-r${i + 1}`).join(',')}',{y:-30,duration:.5,ease:'power2.in'},${(dur - 0.6).toFixed(2)});`);
        return '\n' + lines.join('\n') + '\n';
      };
      return { css, body, tl };
    },
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);
