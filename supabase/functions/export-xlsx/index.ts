import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore
import ExcelJS from "https://esm.sh/exceljs@4.4.0";

const BLUE_HDR  = "FF3C85C6";
const BLUE_MID  = "FF5B9BD5";
const BLUE_LT   = "FFD6E4F0";
const OFF_WHITE = "FFF5F0E8";
const WHITE     = "FFFFFFFF";
const INK       = "FF1A1A18";
const INK_LIGHT = "FF6B6B5F";
const BORDER_C  = { style: "thin" as const, color: { argb: "FFC0C0C0" } };
const THIN_BORDER = { top:BORDER_C, bottom:BORDER_C, left:BORDER_C, right:BORDER_C };

const ACTIVITY_META = [
  { id:"sleep",    label:"Sleep",                            hex:"FF4A7C8E" },
  { id:"meals",    label:"Meals",                            hex:"FFC8773A" },
  { id:"learning", label:"Classes / Homework / Learning",    hex:"FF2D5A3D" },
  { id:"work",     label:"Work",                             hex:"FF5A3D7C" },
  { id:"commute",  label:"Commuting",                        hex:"FF7C6A3D" },
  { id:"social",   label:"Family / Friend Time",             hex:"FF3D7C6A" },
  { id:"hobbies",  label:"Activities / Hobbies",             hex:"FF9B3D7C" },
  { id:"exercise", label:"Exercise",                         hex:"FF3D5A7C" },
  { id:"chores",   label:"Extra Responsibilities / Chores",  hex:"FF8E7A4A" },
  { id:"selfcare", label:"Personal Care",                    hex:"FF7C5A3D" },
  { id:"freetime", label:"Free Time",                        hex:"FF4A8E7A" },
  { id:"other",    label:"Other",                            hex:"FF8E8E8E" },
] as const;

const WS_COL_ORDER = ["sleep","meals","learning","work","commute","social",
                      "hobbies","exercise","chores","selfcare","freetime","other"];

const HOUR_ORDER = [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5];
const DAYS       = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function argbFill(argb: string) {
  return { type:"pattern" as const, pattern:"solid" as const, fgColor:{argb} };
}
function hdrFont(size=10, color=WHITE) {
  return { name:"Arial", size, bold:true, color:{argb:color} };
}
function bodyFont(size=10, bold=false, color=INK) {
  return { name:"Arial", size, bold, color:{argb:color} };
}
const CENTER = { horizontal:"center" as const, vertical:"middle" as const };
const LEFT   = { horizontal:"left"   as const, vertical:"middle" as const };
const RIGHT  = { horizontal:"right"  as const, vertical:"middle" as const };

function tintHex(argb: string): string {
  const r=parseInt(argb.slice(2,4),16), g=parseInt(argb.slice(4,6),16), b=parseInt(argb.slice(6,8),16);
  const f=0.25;
  return `FF${Math.round(r*f+255*(1-f)).toString(16).padStart(2,"0")}${Math.round(g*f+255*(1-f)).toString(16).padStart(2,"0")}${Math.round(b*f+255*(1-f)).toString(16).padStart(2,"0")}`;
}

interface LogEntry   { id:string; activity:string; note:string|null; logged_at:string; week_start:string; user_id:string; }
interface CustomAct  { id:string; label:string; hex:string; }
interface Pref       { key:string; value:string; }

// Local day-of-week (0=Sun) + hour (0-23) + YYYY-MM-DD for a UTC timestamp in the
// given IANA timezone. Mirrors how the app buckets entries (device-local time).
function tzParts(iso: string, tz: string): { day:number; hour:number; date:string } {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:tz,weekday:"short",hour:"2-digit",hour12:false,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(iso));
  const get=(t:string)=>parts.find(p=>p.type===t)?.value||"";
  const wd:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const hour=parseInt(get("hour"),10)%24;
  return { day: wd[get("weekday")] ?? 0, hour, date: `${get("year")}-${get("month")}-${get("day")}` };
}

function fmtWeekRange(iso: string, days=6): string {
  const sun=new Date(iso+"T12:00:00Z"), end=new Date(sun);
  end.setDate(sun.getDate()+days);
  const o:Intl.DateTimeFormatOptions={month:"short",day:"numeric",timeZone:"UTC"};
  return `${sun.toLocaleDateString("en-US",o)} – ${end.toLocaleDateString("en-US",o)}`;
}

// Equal split per DISTINCT activity per local hour-slot (matches the app's calendar/summary).
function estimateHours(logs: LogEntry[], tz: string): Record<string,number> {
  const slots:Record<string,Set<string>>={};
  for (const l of logs) {
    const {day,hour}=tzParts(l.logged_at,tz);
    const key=`${day}_${hour}`;
    (slots[key]=slots[key]||new Set()).add(l.activity);
  }
  const h:Record<string,number>={};
  for (const set of Object.values(slots)) {
    const per=1/set.size;
    for (const a of set) h[a]=(h[a]||0)+per;
  }
  return h;
}

// Distinct activities per local hour-slot (collapses repeats), like the calendar.
function buildSched(logs: LogEntry[], tz: string): Record<string,string[]> {
  const s:Record<string,string[]>={};
  for (const l of logs) {
    const {day,hour}=tzParts(l.logged_at,tz);
    const key=`${day}_${hour}`;
    if(!s[key]) s[key]=[];
    if(!s[key].includes(l.activity)) s[key].push(l.activity);
  }
  return s;
}

function getWkLogs(logs: LogEntry[], wk: string): LogEntry[] {
  return logs.filter(l=>l.week_start===wk);
}

function buildHowSheet(
  ws: any,
  title: string,
  logsA: LogEntry[],
  logsB: LogEntry[]|null,
  customActs: CustomAct[],
  weekSize: number,
  summaryTotalsRow: number,
  actMap: Record<string,{label:string,hex:string}>,
  tz: string,
) {
  const is336 = weekSize===336;

  ws.mergeCells("A1:H1");
  Object.assign(ws.getCell("A1"), {
    value:title, font:hdrFont(13), fill:argbFill(BLUE_HDR), alignment:CENTER,
  });
  ws.getRow(1).height=26;

  ws.mergeCells("A2:H2");
  const d2=ws.getCell("A2");
  d2.value="Directions: There are only so many hours in a week. Most of us have busy schedules, so it's important to think about the way you current spend, plan, and organize your time. For this assignment, you'll be asked to assess your current schedule and the hourly amount of time spent on various activities in order to get a clear picture of how you spend your 168 hours each week.";
  d2.font=bodyFont(9); d2.fill=argbFill(BLUE_LT);
  d2.alignment={horizontal:"left",vertical:"top",wrapText:true};
  ws.getRow(2).height=52;

  function writePart1(startRow: number, partLabel: string, logs: LogEntry[]): number {
    ws.getCell(startRow,1).value=partLabel;
    ws.getCell(startRow,1).font=bodyFont(10,true);
    ws.getRow(startRow).height=16;
    const hRow=startRow+1; ws.getRow(hRow).height=18;
    const th=ws.getCell(hRow,1);
    th.value="Time:"; th.font=hdrFont(10); th.fill=argbFill(BLUE_HDR); th.alignment=CENTER; th.border=THIN_BORDER;
    for(let d=0;d<7;d++){
      const c=ws.getCell(hRow,d+2);
      c.value=DAYS[d]; c.font=hdrFont(10); c.fill=argbFill(BLUE_HDR); c.alignment=CENTER; c.border=THIN_BORDER;
    }
    const sched=buildSched(logs,tz); const ds=hRow+1;
    for(let hi=0;hi<HOUR_ORDER.length;hi++){
      const h24=HOUR_ORDER[hi]; const er=ds+hi;
      ws.getRow(er).height=18;
      const tc=ws.getCell(er,1);
      tc.value=h24/24; tc.numFmt="h:MM AM/PM";
      tc.font={name:"Arial",size:9,bold:true,color:{argb:BLUE_HDR}};
      tc.fill=argbFill(hi%2===0?OFF_WHITE:WHITE); tc.alignment=CENTER; tc.border=THIN_BORDER;
      for(let day=0;day<7;day++){
        const acts=sched[`${day}_${h24}`]||[];
        const cell=ws.getCell(er,day+2); cell.border=THIN_BORDER; cell.alignment=CENTER;
        if(acts.length>0){
          const lbl=acts.slice(0,2).map((id:string)=>(actMap[id]?.label||id).split("/")[0].trim().slice(0,12)).join(" / ")+(acts.length>2?"…":"");
          cell.value=lbl; cell.fill=argbFill(actMap[acts[0]]?.hex||"FF888888");
          cell.font={name:"Arial",size:8,color:{argb:WHITE}};
        } else {
          cell.fill=argbFill(hi%2===0?OFF_WHITE:"FFFAFAF7");
          cell.font=bodyFont(9,false,"FFCCCCCC");
        }
      }
    }
    return ds+HOUR_ORDER.length;
  }

  let nextRow: number;
  if(!is336) { nextRow=writePart1(3,"Part 1",logsA); }
  else { nextRow=writePart1(3,"Part 1 — Week A (Week 1)",logsA); nextRow+=1; nextRow=writePart1(nextRow,"Part 1 — Week B (Week 2)",logsB||[]); }

  const p2=nextRow+1;
  ws.getCell(p2,1).value="Part 2"; ws.getCell(p2,1).font=bodyFont(10,true); ws.getRow(p2).height=16;
  ws.mergeCells(`A${p2+1}:H${p2+1}`);
  const d2b=ws.getCell(p2+1,1);
  d2b.value="Directions: Based on your schedule above, write down how much time you intend to spend on average in a week for each of the following activities:";
  d2b.font=bodyFont(9); d2b.fill=argbFill(BLUE_LT);
  d2b.alignment={horizontal:"left",vertical:"top",wrapText:true};
  ws.getRow(p2+1).height=36;

  const hRow2=p2+2; ws.getRow(hRow2).height=18;
  const ah=ws.getCell(hRow2,1); ah.value="Activity"; ah.font=hdrFont(10); ah.fill=argbFill(BLUE_HDR); ah.alignment=LEFT; ah.border=THIN_BORDER;
  ws.mergeCells(`G${hRow2}:H${hRow2}`);
  const hh=ws.getCell(hRow2,7);
  hh.value=is336?"Time Spent (hrs, 2-wk total)":"Time Spent (in hours)";
  hh.font=hdrFont(10); hh.fill=argbFill(BLUE_HDR); hh.alignment=CENTER; hh.border=THIN_BORDER;

  const SR=summaryTotalsRow;
  const p2Acts=[
    {label:"Sleep",             formula:`='Weekly Summary'!D${SR}`},
    {label:"Meals",             formula:`='Weekly Summary'!E${SR}`},
    {label:"Classes/Homework/Learning", formula:`='Weekly Summary'!F${SR}`},
    {label:"Work",              formula:`='Weekly Summary'!G${SR}`},
    {label:"Commuting",         formula:`='Weekly Summary'!H${SR}`},
    {label:"Family/Friend Time",formula:`='Weekly Summary'!I${SR}`},
    {label:"Activities (hobbies, exercise, spiritual practice, etc.)", formula:`='Weekly Summary'!J${SR}+'Weekly Summary'!K${SR}`},
    {label:"Extra Responsibilities (chores, obligations, etc.)", formula:`='Weekly Summary'!L${SR}`},
    {label:"Personal Care",     formula:`='Weekly Summary'!M${SR}`},
    {label:"Free Time",         formula:`='Weekly Summary'!N${SR}`},
    {label:"Other: ",           formula:`='Weekly Summary'!O${SR}`},
  ];
  // Add custom activities
  for (const c of customActs) {
    const col=String.fromCharCode(80+customActs.indexOf(c)); // P, Q, R...
    p2Acts.push({label:c.label, formula:`='Weekly Summary'!${col}${SR}`});
  }

  const ads=hRow2+1;
  for(let i=0;i<p2Acts.length;i++){
    const {label,formula}=p2Acts[i]; const r=ads+i; const bg=i%2===0?OFF_WHITE:WHITE;
    ws.getRow(r).height=18;
    const lc=ws.getCell(r,1); lc.value=label; lc.font=bodyFont(10); lc.fill=argbFill(bg); lc.alignment=LEFT; lc.border=THIN_BORDER;
    ws.mergeCells(`G${r}:H${r}`);
    const vc=ws.getCell(r,7); vc.value={formula}; vc.font=bodyFont(10,true); vc.fill=argbFill(bg); vc.alignment=CENTER; vc.border=THIN_BORDER;
  }
  const lastAct=ads+p2Acts.length-1; const totR=lastAct+1; const remR=totR+1; const hrs=is336?336:168;
  for(const [r,lbl,formula] of [[totR,"Total =",`=SUM(G${ads}:H${lastAct})`],[remR,"Hours Remaining =",`=${hrs}-G${totR}`]] as [number,string,string][]){
    ws.getRow(r).height=18;
    ws.mergeCells(`E${r}:F${r}`);
    const lc=ws.getCell(r,5); lc.value=lbl; lc.font=bodyFont(10,true); lc.alignment=RIGHT;
    ws.mergeCells(`G${r}:H${r}`);
    const vc=ws.getCell(r,7); vc.value={formula}; vc.font=bodyFont(10,true); vc.fill=argbFill(BLUE_LT); vc.alignment=CENTER; vc.border=THIN_BORDER;
  }
  ws.getColumn(1).width=14;
  for(let c=2;c<=7;c++) ws.getColumn(c).width=16;
  ws.getColumn(8).width=18;
}

async function buildWorkbook(logs: LogEntry[], customActs: CustomAct[], userEmail: string, weekSize: number, tz: string): Promise<ArrayBuffer> {
  logs.sort((a,b)=>a.logged_at.localeCompare(b.logged_at));
  const allWks=[...new Set(logs.map(l=>l.week_start))].sort();
  const lastWk=allWks.at(-1)||""; const prevWk=allWks.at(-2)||lastWk;

  const weekHours:Record<string,Record<string,number>>={}
  for(const wk of allWks) weekHours[wk]=estimateHours(getWkLogs(logs,wk),tz);
  const allHours:Record<string,number>={};
  for(const wh of Object.values(weekHours)) for(const [a,h] of Object.entries(wh)) allHours[a]=(allHours[a]||0)+h;

  const actMap:Record<string,{label:string,hex:string}>={}
  for(const a of ACTIVITY_META) actMap[a.id]={label:a.label,hex:a.hex};
  for(const c of customActs) actMap["custom_"+c.id]={label:c.label,hex:"FF"+c.hex.replace("#","")};

  const summaryTotalsRow=allWks.length+2;
  const wb=new ExcelJS.Workbook(); wb.creator="168 Hours"; wb.created=new Date();

  // 1. HowManyHours
  buildHowSheet(wb.addWorksheet("HowManyHours"),"How Are You Spending Your Time?",
    getWkLogs(logs,lastWk),null,customActs,168,summaryTotalsRow,actMap,tz);

  // 2. HowManyHours (336)
  buildHowSheet(wb.addWorksheet("HowManyHours (336)"),"How Are You Spending Your Time?  —  336 Hours (2 Weeks)",
    getWkLogs(logs,prevWk),getWkLogs(logs,lastWk),customActs,336,summaryTotalsRow,actMap,tz);

  // 3. Export Info
  const wsInfo=wb.addWorksheet("Export Info");
  wsInfo.getColumn(1).width=28; wsInfo.getColumn(2).width=48;
  wsInfo.mergeCells("A1:B1");
  const it=wsInfo.getCell("A1"); it.value="168 Hours — Data Export";
  it.font=hdrFont(14); it.fill=argbFill(BLUE_HDR); it.alignment=CENTER; wsInfo.getRow(1).height=32;
  const infoRows:any[]=[
    ["Export date",new Date().toISOString().replace("T"," ").slice(0,16)+" UTC"],
    ["Account email",userEmail],["Week size setting",`${weekSize} hours`],
    ["Timezone",tz],
    ["Total log entries",logs.length],["Weeks with data",allWks.length],
    ["Custom activities",customActs.length?customActs.map(c=>c.label).join(", "):"None defined"],
    ["Activity categories",ACTIVITY_META.length+customActs.length],
    ["Date range",logs.length?`${logs[0].logged_at.slice(0,10)} to ${logs.at(-1)!.logged_at.slice(0,10)}`:"No data"],
    ["",""],
    ["Sheets",""],
    ["1. HowManyHours","168-hr worksheet replica with live formulas (current week)"],
    ["2. HowManyHours (336)","Two-week worksheet with Week A + Week B grids"],
    ["3. Export Info","This sheet"],
    ["4. Raw Log","Every log entry with full timestamp, day, hour, activity, note"],
    ["5. Weekly Summary","Pivot: hours per activity per week (feeds HowManyHours Part 2)"],
    ["6. Activity Definitions","All categories with color hex and total entry counts"],
    ["7. Weekly Schedule","Hour-by-hour grid for most recent week"],
    ["8. 168-Hr Worksheet","Part 2 summary across all weeks combined"],
    ["9. Daily Patterns","Heatmap: entry counts by day of week and hour"],
  ];
  for(let i=0;i<infoRows.length;i++){
    const row=wsInfo.getRow(i+2); row.height=17;
    const [k,v]=infoRows[i]; const bg=(i+2)%2===0?OFF_WHITE:WHITE;
    row.getCell(1).value=k; row.getCell(2).value=v;
    row.getCell(1).font=bodyFont(10,!!k&&!String(k).match(/^\d/));
    if(String(k).match(/^\d/)) row.getCell(1).font={name:"Arial",size:10,color:{argb:BLUE_HDR}};
    row.getCell(2).font=bodyFont();
    row.getCell(1).fill=argbFill(bg); row.getCell(2).fill=argbFill(bg);
    row.getCell(1).border=THIN_BORDER; row.getCell(2).border=THIN_BORDER;
  }

  // 4. Raw Log
  const wsRaw=wb.addWorksheet("Raw Log");
  const rawCols=["#","Timestamp (UTC)","Local Date","Local Time","Day of Week","Hour (24h)","Week Start","Week #","Activity ID","Activity Label","Note","Is Real Entry"];
  const rawW=[5,24,13,10,13,10,13,8,14,32,28,13];
  for(let c=0;c<rawCols.length;c++){
    wsRaw.getColumn(c+1).width=rawW[c];
    const cell=wsRaw.getRow(1).getCell(c+1);
    cell.value=rawCols[c]; cell.fill=argbFill(BLUE_HDR); cell.font=hdrFont(10); cell.alignment=CENTER; cell.border=THIN_BORDER;
  }
  wsRaw.getRow(1).height=20; wsRaw.views=[{state:"frozen",ySplit:1}];
  for(let i=0;i<logs.length;i++){
    const l=logs[i]; const dt=new Date(l.logged_at);
    const lp=tzParts(l.logged_at,tz);
    const localTime=new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"2-digit",minute:"2-digit",hour12:false}).format(dt);
    const dayName=DAYS[lp.day];
    const rd=[i+1,l.logged_at.replace("T"," ").slice(0,19)+" UTC",lp.date,localTime,dayName,lp.hour,l.week_start,allWks.indexOf(l.week_start)+1,l.activity,actMap[l.activity]?.label||l.activity,l.note||"",l.user_id?"Yes":"Simulated"];
    const row=wsRaw.getRow(i+2); row.height=16;
    for(let c=0;c<rd.length;c++){const cell=row.getCell(c+1);cell.value=rd[c];cell.font={name:"Arial",size:9,color:{argb:INK}};cell.alignment=LEFT;cell.border=THIN_BORDER;}
    const bg=l.user_id?BLUE_LT:((i+2)%2===0?OFF_WHITE:WHITE);
    for(let c=1;c<=rawCols.length;c++) row.getCell(c).fill=argbFill(bg);
  }

  // 5. Weekly Summary
  const wsPivot=wb.addWorksheet("Weekly Summary");
  const actCols=[...WS_COL_ORDER,...customActs.map(c=>"custom_"+c.id)];
  const pivotHdrs=["Week Start","Week #","Total Entries",...actCols.map(id=>actMap[id]?.label||id),"Total Est. Hours","168hr Coverage %"];
  for(let c=0;c<pivotHdrs.length;c++){
    const cell=wsPivot.getRow(1).getCell(c+1);
    cell.value=pivotHdrs[c]; cell.fill=argbFill(BLUE_HDR); cell.font=hdrFont(9); cell.alignment=CENTER; cell.border=THIN_BORDER;
  }
  wsPivot.getRow(1).height=20; wsPivot.views=[{state:"frozen",ySplit:1}];
  wsPivot.getColumn(1).width=13; wsPivot.getColumn(2).width=8; wsPivot.getColumn(3).width=14;
  for(let c=4;c<=pivotHdrs.length;c++) wsPivot.getColumn(c).width=13;
  for(let wi=0;wi<allWks.length;wi++){
    const wk=allWks[wi]; const wkLogs=getWkLogs(logs,wk);
    const row=wsPivot.getRow(wi+2); row.height=17;
    row.getCell(1).value=wk; row.getCell(2).value=wi+1; row.getCell(3).value=wkLogs.length;
    let tot=0;
    for(let ci=0;ci<actCols.length;ci++){
      const h=Math.round((weekHours[wk]?.[actCols[ci]]||0)*10)/10; tot+=h;
      const cell=row.getCell(ci+4);
      if(h>0){cell.value=h;cell.fill=argbFill(tintHex((actMap[actCols[ci]]?.hex||"FF888888").slice(0,8).padStart(8,"FF")));}
      cell.border=THIN_BORDER;
    }
    row.getCell(4+actCols.length).value=Math.round(tot*10)/10;
    row.getCell(4+actCols.length).border=THIN_BORDER;
    const pctCell=row.getCell(5+actCols.length);
    pctCell.value=Math.round(tot/168*1000)/1000; pctCell.numFmt="0.0%"; pctCell.border=THIN_BORDER;
    const bg=(wi+2)%2===0?OFF_WHITE:WHITE;
    for(let c=1;c<=pivotHdrs.length;c++){const cell=row.getCell(c);if(!cell.fill||cell.fill.type==="none")cell.fill=argbFill(bg);cell.border=THIN_BORDER;}
  }
  // ALL WEEKS COMBINED row
  const totRow=wsPivot.getRow(summaryTotalsRow); totRow.height=18;
  totRow.getCell(1).value="ALL WEEKS COMBINED"; totRow.getCell(3).value=logs.length;
  let grand=0;
  for(let ci=0;ci<actCols.length;ci++){
    const h=Math.round((allHours[actCols[ci]]||0)*10)/10; grand+=h;
    if(h>0) totRow.getCell(ci+4).value=h; totRow.getCell(ci+4).border=THIN_BORDER;
  }
  totRow.getCell(4+actCols.length).value=Math.round(grand*10)/10;
  for(let c=1;c<=pivotHdrs.length;c++){totRow.getCell(c).fill=argbFill(BLUE_HDR);totRow.getCell(c).font=hdrFont(9);totRow.getCell(c).border=THIN_BORDER;}

  // 6. Activity Definitions
  const wsActs=wb.addWorksheet("Activity Definitions");
  wsActs.getColumn(1).width=16; wsActs.getColumn(2).width=38; wsActs.getColumn(3).width=11; wsActs.getColumn(4).width=10; wsActs.getColumn(5).width=18;
  for(const [ci,h] of ["Activity ID","Full Label","Color Hex","Type","Total Entries (all weeks)"].entries()){
    const cell=wsActs.getRow(1).getCell(ci+1);
    cell.value=h; cell.fill=argbFill(BLUE_HDR); cell.font=hdrFont(10); cell.alignment=CENTER; cell.border=THIN_BORDER;
  }
  wsActs.getRow(1).height=20;
  const actCounts:Record<string,number>={}; for(const l of logs) actCounts[l.activity]=(actCounts[l.activity]||0)+1;
  const allActDefs=[...ACTIVITY_META.map(a=>({id:a.id,label:a.label,hex:a.hex,type:"Built-in"})),...customActs.map(c=>({id:"custom_"+c.id,label:c.label,hex:"FF"+c.hex.replace("#",""),type:"Custom"}))];
  for(let i=0;i<allActDefs.length;i++){
    const {id,label,hex,type}=allActDefs[i]; const row=wsActs.getRow(i+2); row.height=17;
    const bg=(i+2)%2===0?OFF_WHITE:WHITE;
    row.getCell(1).value=id; row.getCell(1).font=bodyFont(); row.getCell(1).fill=argbFill(bg); row.getCell(1).border=THIN_BORDER;
    row.getCell(2).value=label; row.getCell(2).font=bodyFont(); row.getCell(2).fill=argbFill(bg); row.getCell(2).border=THIN_BORDER;
    const hc=row.getCell(3); hc.value=`#${hex.slice(2)}`; hc.fill=argbFill(hex); hc.font={name:"Arial",size:10,bold:true,color:{argb:WHITE}}; hc.alignment=CENTER; hc.border=THIN_BORDER;
    row.getCell(4).value=type; row.getCell(4).font=bodyFont(); row.getCell(4).fill=argbFill(bg); row.getCell(4).border=THIN_BORDER;
    row.getCell(5).value=actCounts[id]||0; row.getCell(5).font=bodyFont(); row.getCell(5).fill=argbFill(bg); row.getCell(5).alignment=CENTER; row.getCell(5).border=THIN_BORDER;
  }

  // 7. Weekly Schedule
  const wsSched=wb.addWorksheet("Weekly Schedule");
  wsSched.mergeCells("A1:H1");
  const st=wsSched.getCell("A1"); st.value="How Are You Spending Your Time? — Part 1: Weekly Schedule";
  st.font=hdrFont(12); st.fill=argbFill(BLUE_HDR); st.alignment=CENTER; wsSched.getRow(1).height=26;
  wsSched.mergeCells("A2:H2");
  const ss=wsSched.getCell("A2"); ss.value=lastWk?`Week of ${fmtWeekRange(lastWk)}`:"No data";
  ss.font=bodyFont(10,false,WHITE); ss.fill=argbFill(BLUE_MID); ss.alignment=CENTER; wsSched.getRow(2).height=17;
  const sth=wsSched.getCell(3,1); sth.value="Time"; sth.fill=argbFill(BLUE_HDR); sth.font=hdrFont(10); sth.alignment=CENTER; sth.border=THIN_BORDER;
  for(let d=0;d<7;d++){const c=wsSched.getCell(3,d+2);c.value=DAYS[d];c.fill=argbFill(BLUE_HDR);c.font=hdrFont(10);c.alignment=CENTER;c.border=THIN_BORDER;}
  wsSched.getRow(3).height=18;
  const wk4Sched=buildSched(getWkLogs(logs,lastWk),tz);
  for(let hi=0;hi<HOUR_ORDER.length;hi++){
    const h24=HOUR_ORDER[hi]; const er=hi+4; wsSched.getRow(er).height=18;
    const tc=wsSched.getCell(er,1); tc.value=h24/24; tc.numFmt="h:MM AM/PM";
    tc.font={name:"Arial",size:9,bold:true,color:{argb:BLUE_HDR}}; tc.fill=argbFill(hi%2===0?OFF_WHITE:WHITE); tc.alignment=CENTER; tc.border=THIN_BORDER;
    for(let day=0;day<7;day++){
      const acts=wk4Sched[`${day}_${h24}`]||[]; const cell=wsSched.getCell(er,day+2); cell.border=THIN_BORDER; cell.alignment=CENTER;
      if(acts.length>0){
        const lbl=acts.slice(0,2).map((id:string)=>(actMap[id]?.label||id).split("/")[0].trim().slice(0,12)).join(" / ")+(acts.length>2?"…":"");
        cell.value=lbl; cell.fill=argbFill(actMap[acts[0]]?.hex||"FF888888"); cell.font={name:"Arial",size:8,color:{argb:WHITE}};
      } else { cell.fill=argbFill(hi%2===0?OFF_WHITE:"FFFAFAF7"); }
    }
  }
  wsSched.getColumn(1).width=12; for(let c=2;c<=8;c++) wsSched.getColumn(c).width=16;
  wsSched.views=[{state:"frozen",xSplit:1,ySplit:3}];

  // 8. 168-Hr Worksheet
  const ws168=wb.addWorksheet("168-Hr Worksheet");
  ws168.mergeCells("A1:D1"); const t168=ws168.getCell("A1"); t168.value="How Are You Spending Your Time?";
  t168.font=hdrFont(14); t168.fill=argbFill(BLUE_HDR); t168.alignment=CENTER; ws168.getRow(1).height=30;
  ws168.mergeCells("A2:D2"); const s168=ws168.getCell("A2"); s168.value="Part 2 — Activity Summary (All Weeks Combined)";
  s168.font=bodyFont(10,false,WHITE); s168.fill=argbFill(BLUE_MID); s168.alignment=CENTER; ws168.getRow(2).height=17;
  for(const [ci,h] of ["Activity","Est. Hours","% of 168","Per-Week Avg (hrs)"].entries()){
    const c=ws168.getCell(3,ci+1); c.value=h; c.fill=argbFill(BLUE_HDR); c.font=hdrFont(10); c.alignment=CENTER; c.border=THIN_BORDER;
  }
  ws168.getRow(3).height=18;
  const allActMeta=[...ACTIVITY_META.map(a=>({id:a.id,label:a.label,hex:a.hex})),...customActs.map(c=>({id:"custom_"+c.id,label:c.label,hex:"FF"+c.hex.replace("#","")})),];
  for(let i=0;i<allActMeta.length;i++){
    const {id,label,hex}=allActMeta[i]; const h=Math.round((allHours[id]||0)*10)/10;
    const per=allWks.length>0?Math.round(h/allWks.length*10)/10:0;
    const bg=i%2===0?OFF_WHITE:WHITE; const r=i+4; ws168.getRow(r).height=18;
    const nc=ws168.getCell(r,1); nc.value=`  ${label}`;
    nc.fill=h>0?argbFill(hex):argbFill(bg); nc.font=h>0?{name:"Arial",size:10,color:{argb:WHITE}}:bodyFont(10);
    nc.alignment=LEFT; nc.border=THIN_BORDER;
    const hc=ws168.getCell(r,2); if(h>0)hc.value=h; hc.font=bodyFont(10,h>0); hc.fill=argbFill(bg); hc.alignment=CENTER; hc.border=THIN_BORDER;
    const pc=ws168.getCell(r,3); if(h>0){pc.value=h/168;pc.numFmt="0.0%";} pc.font=bodyFont(10); pc.fill=argbFill(bg); pc.alignment=CENTER; pc.border=THIN_BORDER;
    const ac=ws168.getCell(r,4); if(per>0)ac.value=per; ac.font=bodyFont(10); ac.fill=argbFill(bg); ac.alignment=CENTER; ac.border=THIN_BORDER;
  }
  const ld=3+allActMeta.length; const tR=ld+2; const rR=tR+1;
  for(const [r,lbl,formula] of [[tR,"Total =",`=SUM(B4:B${ld})`],[rR,"Hours Remaining =",`=168-B${tR}`]] as [number,string,string][]){
    ws168.getRow(r).height=18; ws168.getCell(r,1).value=lbl; ws168.getCell(r,1).font=bodyFont(10,true);
    const vc=ws168.getCell(r,2); vc.value={formula}; vc.font=bodyFont(10,true); vc.fill=argbFill(BLUE_LT); vc.alignment=CENTER; vc.border=THIN_BORDER;
    for(let c=1;c<=4;c++) ws168.getCell(r,c).fill=argbFill(BLUE_LT);
  }
  ws168.getColumn(1).width=36; ws168.getColumn(2).width=16; ws168.getColumn(3).width=12; ws168.getColumn(4).width=20;

  // 9. Daily Patterns
  const wsPat=wb.addWorksheet("Daily Patterns");
  wsPat.mergeCells("A1:I1"); const pt=wsPat.getCell("A1"); pt.value="Daily Activity Patterns — Entry Count by Day of Week & Hour";
  pt.font=hdrFont(12); pt.fill=argbFill(BLUE_HDR); pt.alignment=CENTER; wsPat.getRow(1).height=24;
  const DAYS_PAT=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const hr2=wsPat.getRow(2); hr2.height=18;
  const h0=hr2.getCell(1); h0.value="Hour"; h0.fill=argbFill(BLUE_HDR); h0.font=hdrFont(10); h0.alignment=CENTER; h0.border=THIN_BORDER;
  for(let d=0;d<7;d++){const c=hr2.getCell(d+2);c.value=DAYS_PAT[d];c.fill=argbFill(BLUE_HDR);c.font=hdrFont(10);c.alignment=CENTER;c.border=THIN_BORDER;}
  const tc2=hr2.getCell(9); tc2.value="Total"; tc2.fill=argbFill(BLUE_MID); tc2.font=hdrFont(10); tc2.border=THIN_BORDER;
  const dayHourCounts:Record<string,number>={};
  for(const l of logs){const {day,hour}=tzParts(l.logged_at,tz);dayHourCounts[`${day}_${hour}`]=(dayHourCounts[`${day}_${hour}`]||0)+1;}
  const maxCnt=Math.max(...Object.values(dayHourCounts),1);
  wsPat.getColumn(1).width=12; for(let c=2;c<=9;c++) wsPat.getColumn(c).width=9;
  wsPat.views=[{state:"frozen",ySplit:2}];
  for(let hi=0;hi<HOUR_ORDER.length;hi++){
    const h24=HOUR_ORDER[hi]; const r=hi+3; wsPat.getRow(r).height=17;
    const tl=wsPat.getCell(r,1); tl.value=h24/24; tl.numFmt="h:MM AM/PM";
    tl.font={name:"Arial",size:9,bold:true,color:{argb:BLUE_HDR}}; tl.fill=argbFill(OFF_WHITE); tl.alignment=CENTER; tl.border=THIN_BORDER;
    let rowTot=0;
    for(let d=0;d<7;d++){
      const jsDay=(d+1)%7; const cnt=dayHourCounts[`${jsDay}_${h24}`]||0; rowTot+=cnt;
      const cell=wsPat.getCell(r,d+2); cell.border=THIN_BORDER; cell.alignment=CENTER;
      if(cnt>0){
        const intensity=cnt/maxCnt;
        const rv=Math.round(60+intensity*(3-60)); const gv=Math.round(133-intensity*88); const bv=Math.round(198-intensity*137);
        cell.fill=argbFill(`FF${rv.toString(16).padStart(2,"0")}${gv.toString(16).padStart(2,"0")}${bv.toString(16).padStart(2,"0")}`);
        cell.value=cnt; cell.font={name:"Arial",size:9,color:{argb:intensity>0.5?WHITE:INK}};
      } else { cell.fill=argbFill("FFFAFAF7"); cell.font={name:"Arial",size:9,color:{argb:"FFDDDDDD"}}; }
    }
    const tc3=wsPat.getCell(r,9); if(rowTot>0)tc3.value=rowTot;
    tc3.font={name:"Arial",size:9,bold:true}; tc3.fill=argbFill(BLUE_LT); tc3.alignment=CENTER; tc3.border=THIN_BORDER;
  }

  const buffer=await wb.xlsx.writeBuffer();
  return buffer;
}

Deno.serve(async (req: Request) => {
  if(req.method==="OPTIONS") return new Response(null,{headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Authorization, Content-Type"}});
  if(req.method!=="POST") return new Response("Method not allowed",{status:405});

  const authHeader=req.headers.get("Authorization");
  if(!authHeader) return new Response("Unauthorized",{status:401});

  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authHeader}}});
  const {data:{user},error:authErr}=await supabase.auth.getUser();
  if(authErr||!user) return new Response("Unauthorized",{status:401});

  const [logsRes,customRes,prefsRes]=await Promise.all([
    supabase.from("time_logs").select("*").order("logged_at",{ascending:true}),
    supabase.from("custom_activities").select("*").order("created_at"),
    supabase.from("user_prefs").select("*"),
  ]);
  if(logsRes.error) return new Response("DB error",{status:500});

  const logs=logsRes.data||[];
  const customActs=customRes.data||[];
  const prefs=prefsRes.data||[];
  const weekSize=parseInt(prefs.find((p:any)=>p.key==="week_size")?.value||"168")||168;
  let tz=(prefs.find((p:any)=>p.key==="tz")?.value)||"America/New_York";
  try { new Intl.DateTimeFormat("en-US",{timeZone:tz}); } catch { tz="America/New_York"; }

  try {
    const buffer=await buildWorkbook(logs,customActs,user.email!,weekSize,tz);
    const dateStr=new Date().toISOString().slice(0,10);
    return new Response(buffer,{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="168-hours-${dateStr}.xlsx"`,"Access-Control-Allow-Origin":"*"}});
  } catch(err) {
    console.error("Export error:",err);
    return new Response("Export failed: "+String(err),{status:500});
  }
});
