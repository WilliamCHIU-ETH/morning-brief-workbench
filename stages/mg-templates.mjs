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
      if (!Array.isArray(d.nodes) || d.nodes.length !== 3) {
        return 'chain 需要正好 3 個 nodes（節點寬 300px，三節加兩個箭頭剛好 984px）';
      }
      return null;
    },
    render(C, d) {
      const css = `
#d-title{left:0;top:0}
.node{position:absolute;top:290px;width:300px;height:250px;border-radius:26px;background:${C.bg2};border:5px solid ${C.line};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 20px}
.node span{font-size:54px;font-weight:700;color:${C.sub};line-height:1.25}
#d-n1{left:0}
#d-n2{left:342px}
#d-n3{left:684px}
.arw{position:absolute;top:400px;width:30px;height:30px;border-top:6px solid ${C.line};border-right:6px solid ${C.line};transform:rotate(45deg)}
#d-a1{left:306px}
#d-a2{left:648px}
#d-band{position:absolute;left:0;top:660px;width:984px;height:150px;border-radius:26px;background:${C.upFill};display:flex;align-items:center;justify-content:center}
#d-band span{font-size:64px;font-weight:700}
`;
      const body = `      <div class="t h1" id="d-title">${d.title}</div>
      <div class="node" id="d-n1"><span>${d.nodes[0]}</span></div>
      <div class="arw" id="d-a1"></div>
      <div class="node" id="d-n2"><span>${d.nodes[1]}</span></div>
      <div class="arw" id="d-a2"></div>
      <div class="node" id="d-n3"><span id="d-n3t">${d.nodes[2]}</span></div>
      ${d.band ? `<div id="d-band"><span>${d.band}</span></div>` : ''}
`;
      const tl = (dur) => `
  tl.fromTo('#d-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.38,ease:'power3.out'},0);
  tl.fromTo('#d-n1',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},.34);
  tl.fromTo('#d-a1',{autoAlpha:0},{autoAlpha:1,duration:.24,ease:'power2.out'},.66);
  tl.fromTo('#d-n2',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},.86);
  tl.fromTo('#d-a2',{autoAlpha:0},{autoAlpha:1,duration:.24,ease:'power2.out'},1.18);
  tl.fromTo('#d-n3',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},1.38);
  tl.to('#d-n3',{borderColor:'${C.hi}',duration:.34,ease:'power2.out'},2.1);
  tl.to('#d-n3t',{color:'${C.hi}',duration:.34,ease:'power2.out'},2.1);
${d.band ? `  tl.fromTo('#d-band',{y:40,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},2.6);` : ''}
  tl.to('#d-title,#d-n1,#d-a1,#d-n2,#d-a2,#d-n3${d.band ? ',#d-band' : ''}',{autoAlpha:0,duration:.45,ease:'power2.in'},${(dur - 0.5).toFixed(2)});
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
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);
