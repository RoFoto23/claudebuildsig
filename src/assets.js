/** Static assets embedded as strings (the function bundle has no static file hosting). */
export const CSS = `
:root{--ink:#1f2124;--muted:#5b5f66;--bg:#f6f5f1;--card:#fff;--line:#e3e3e0;--amber:#f5a30a;--amber-d:#8a6d00;--blue:#0b5cad;--green:#1f8a4c;--yellow:#b7791f;--red:#c0392b;--r:12px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--blue)}
.wrap{max-width:980px;margin:0 auto;padding:0 16px}
.narrow{max-width:640px}
header.top{background:var(--ink);color:#fff}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;flex-wrap:wrap;padding-top:6px;padding-bottom:6px}
header.top a{color:#fff;text-decoration:none}
.brand{font-weight:800;font-size:20px;letter-spacing:.01em}
.brand b{color:var(--amber)}
nav.main{display:flex;gap:4px;flex-wrap:wrap}
nav.main a{padding:10px 12px;border-radius:8px;font-size:15px}
nav.main a:hover,nav.main a[aria-current]{background:rgba(255,255,255,.12)}
.banner{background:#fff4d6;border-bottom:1px solid #f0d58a;color:#4a3b00;font-size:14px}
.banner .wrap{padding-top:8px;padding-bottom:8px}
.hero{padding:40px 0 28px}
.hero h1{font-size:clamp(28px,6vw,44px);line-height:1.15;margin:0 0 12px}
.hero p.lead{font-size:18px;color:var(--muted);max-width:640px}
h2{font-size:clamp(22px,4vw,28px);margin:36px 0 12px;line-height:1.25}
h3{font-size:18px;margin:0 0 6px}
.grid{display:grid;gap:14px}
@media(min-width:720px){.grid.c2{grid-template-columns:1fr 1fr}.grid.c3{grid-template-columns:repeat(3,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px}
.card.sample{border-style:dashed}
.muted{color:var(--muted)}
.small{font-size:13px}
.btn{display:inline-block;padding:13px 18px;border-radius:10px;background:var(--amber);color:var(--ink);font-weight:700;text-decoration:none;border:0;cursor:pointer;font-size:16px;min-height:44px}
.btn.alt{background:#eceae4}
.btn.dark{background:var(--ink);color:#fff}
.btn.danger{background:#f9d6d1;color:#7a1b10}
.btn.sm{padding:8px 12px;min-height:38px;font-size:14px}
.btn:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
form.stack label{display:block;font-weight:600;margin:14px 0 4px}
form.stack .hint{font-weight:400;color:var(--muted);font-size:13px}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=search],select,textarea{width:100%;padding:12px;border:1px solid #bbb;border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
textarea{min-height:90px}
fieldset{border:1px solid var(--line);border-radius:var(--r);margin:16px 0;padding:8px 14px 14px;background:#fff}
legend{font-weight:700;padding:0 6px}
.checks{display:grid;gap:2px}
@media(min-width:560px){.checks{grid-template-columns:1fr 1fr}}
.checks label{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:0;padding:9px 4px;min-height:44px}
.checks input{margin-top:4px;width:20px;height:20px;flex:none}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700;background:#eceae4}
.pill.green{background:#d8f0e2;color:#12512d}.pill.yellow{background:#fbecc9;color:#6b4a07}.pill.red{background:#f9d6d1;color:#7a1b10}.pill.sample{background:#fff4d6;color:#6b4a07}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:8px;flex:none;margin-top:6px}
.dot.green{background:var(--green)}.dot.yellow{background:var(--yellow)}.dot.red{background:var(--red)}
ul.check{list-style:none;padding:0;margin:8px 0}
ul.check li{display:flex;align-items:flex-start;padding:3px 0;font-size:14px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.actions form{margin:0}
.price{font-size:34px;font-weight:800}
.price small{font-size:15px;font-weight:400;color:var(--muted)}
ul.plain{padding-left:20px;margin:8px 0}
table.t{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
table.t th,table.t td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
.scroll{overflow-x:auto}
pre.draft{white-space:pre-wrap;word-wrap:break-word;background:#fbfaf7;border:1px solid var(--line);border-radius:8px;padding:12px;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
details{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:10px 14px;margin:8px 0}
summary{cursor:pointer;font-weight:700;min-height:32px}
footer.foot{margin-top:48px;padding:24px 0 40px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.notice{background:#eef5ff;border:1px solid #c9dcf5;border-radius:10px;padding:10px 14px;font-size:14px}
.notice.warn{background:#fff4d6;border-color:#f0d58a}
.notice.bad{background:#fde8e5;border-color:#f3b8b0}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:9}
.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
@media(min-width:720px){.kpi{grid-template-columns:repeat(4,1fr)}}
.kpi .card b{display:block;font-size:24px}
.cols{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
.cols>div{min-width:240px;flex:1}
@media print{header.top,footer.foot,.actions,.banner,.noprint{display:none!important}body{background:#fff}}
`;

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2124"/><path d="M7 22 16 8l9 14z" fill="#f5a30a"/></svg>`;
