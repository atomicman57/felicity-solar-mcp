export const finite = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export function normalizeLiveSnapshots(snapshots,now=new Date()) {
 const parsed=snapshots.map(s=>{const observed=s?.dataTimeStr?new Date(s.dataTimeStr.replace(' ','T')+'+01:00'):null;return {raw:s,observed,fresh:observed&&!Number.isNaN(observed.getTime())&&now-observed<900000&&now-observed>=-60000,voltage:finite(s?.acRInVolt)};});
 const fresh=parsed.filter(s=>s.fresh),latest=fresh.reduce((a,b)=>!a||b.observed>a.observed?b:a,null);
 if(!latest)return null;
 const vs=fresh.filter(s=>s.voltage!==null),gridOn=vs.some(s=>s.voltage>=90)?true:parsed.length>0&&vs.length===parsed.length?false:null;
 const sum=field=>{const nums=fresh.map(s=>finite(s.raw[field])).filter(v=>v!==null);return nums.length?nums.reduce((a,b)=>a+b,0):null;};
 const soc=fresh.map(s=>finite(s.raw.emsSoc)).filter(v=>v!==null),wall=latest.raw.dataTimeStr;
 return {date:wall.slice(0,10),time:wall.slice(11,16),observedAt:latest.observed.toISOString(),pv:sum('pvTotalPower'),load:sum('acTotalOutActPower'),grid:sum('acTtlInpower'),soc:soc.length?soc.reduce((a,b)=>a+b,0)/soc.length:null,voltage:vs.length?Math.max(...vs.map(s=>s.voltage)):null,gridOn,reportSeconds:Math.max(...fresh.map(s=>finite(s.raw.reportFreq)??300)),live:true};
}
export function normalize(date, power, soc, voltages=[]) {
 const fields=Object.fromEntries((power.storageMateDTOS||[]).map(s=>[s.field,s.data]));
 const battery=Object.fromEntries((soc.storageMateDTOS||[]).map(s=>[s.field,s.data]));
 const maps=voltages.map(v=>new Map((v.dataTime||[]).map((t,i)=>[t,Object.fromEntries((v.storageMateDTOS||[]).map(s=>[s.field,finite(s.data?.[i])]))])));
 const smap=new Map((soc.dataTime||[]).map((t,i)=>[t,finite(battery.emsSoc?.[i])]));
 return (power.dataTime||[]).map((time,i)=>{
  const vs=maps.map(m=>m.get(time)).filter(Boolean), volts=vs.map(v=>v.acRInVolt).filter(v=>v!==null&&v!==undefined);
  return {date,time,minute:Number(time.slice(0,2))*60+Number(time.slice(3,5)),pv:finite(fields.pvElectricity?.[i]),grid:finite(fields.gridInput?.[i]),load:finite(fields.backupLoad?.[i]),charge:finite(fields.batteryCharging?.[i]),discharge:finite(fields.batteryDischarge?.[i]),soc:smap.get(time)??null,voltage:volts.length?Math.max(...volts):null,temp:vs.map(v=>v.devTempMin).filter(v=>v!==null&&v!==undefined).reduce((a,b)=>Math.max(a??b,b),null),gridOn:volts.some(v=>v>=90)?true:volts.length===maps.length&&maps.length>0?false:null};
 });
}
export function summarize(date, samples, reportedKwh, now=new Date()) {
 const today=now.toLocaleDateString('en-CA',{timeZone:'Africa/Lagos'}), current=now.toLocaleTimeString('en-GB',{timeZone:'Africa/Lagos',hour12:false}).split(':').map(Number);
 const limit=date===today?current[0]*60+current[1]:1440;
 const valid=samples.filter(s=>s.minute<limit), peak=valid.filter(s=>s.pv!==null).reduce((a,b)=>!a||b.pv>a.pv?b:a,null);
 let pvKwh=0,gridKwh=0,loadKwh=0,chargeKwh=0,dischargeKwh=0,gridHours=0,gridKnownHours=0,coverageHours=0,lowHours=0,peakHours=0,longestOutage=0,run=0;
 const windows=[];let open=null,previousMinute=null;
 for(const s of valid){const dt=Math.max(0,Math.min(5,limit-s.minute))/60;
  if(s.pv!==null){coverageHours+=dt;pvKwh+=s.pv*dt/1000;}
  for(const [key,assign] of [['grid',v=>gridKwh+=v],['load',v=>loadKwh+=v],['charge',v=>chargeKwh+=v],['discharge',v=>dischargeKwh+=v]])if(s[key]!==null)assign(Math.abs(s[key])*dt/1000);
  if(s.soc!==null&&s.soc<20)lowHours+=dt;
  if(peak?.pv>0&&s.pv!==null&&s.pv>=peak.pv*.9){peakHours+=dt; if(!open||s.minute>open.end){open={start:s.minute,end:s.minute+dt*60};windows.push(open);}else open.end=s.minute+dt*60;}else open=null;
  if(previousMinute!==null&&s.minute-previousMinute>5)run=0;
  if(s.gridOn!==null){gridKnownHours+=dt;if(s.gridOn){gridHours+=dt;run=0;}else{run+=dt;longestOutage=Math.max(run,longestOutage);}}else run=0;
  previousMinute=s.minute;
 }
 const lowest=valid.filter(s=>s.soc!==null).reduce((a,b)=>!a||b.soc<a.soc?b:a,null);
 return {date,pvKwh:coverageHours>0?(finite(reportedKwh)??pvKwh):null,integratedPvKwh:coverageHours>0?pvKwh:null,gridKwh,loadKwh,chargeKwh,dischargeKwh,gridHours,gridKnownHours,coverageHours,lowHours,peakHours,peak:peak?{watts:peak.pv,time:peak.time}:null,peakWindows:windows,lowest:lowest?{soc:lowest.soc,time:lowest.time}:null,longestOutage,samples};
}
export function analyze(days, now=new Date()) {
 const heat=Array.from({length:7},()=>Array.from({length:24},()=>({on:0,total:0,days:new Set()})));
 for(const d of days)for(const s of d.samples)if(s.gridOn!==null){const weekday=new Date(d.date+'T12:00:00+01:00').getUTCDay(),c=heat[weekday][Math.floor(s.minute/60)];c.total++;c.on+=Number(s.gridOn);c.days.add(d.date);}
 const heatmap=heat.map(row=>row.map(c=>({probability:c.total?c.on/c.total:null,samples:c.total,days:c.days.size})));
 const forecast=[];const base=new Date(Math.floor(now.getTime()/3600000)*3600000+3600000);
 for(let i=0;i<24;i++){const t=new Date(base.getTime()+i*3600000);const local=new Date(t.getTime()+3600000),c=heatmap[local.getUTCDay()][local.getUTCHours()];forecast.push({at:t.toISOString(),hour:local.getUTCHours(),...c});}
 const next=forecast.find(c=>c.days>=3&&c.probability>=.6)??null;
 const best=days.filter(d=>d.coverageHours>0&&d.pvKwh!==null).reduce((a,b)=>!a||b.pvKwh>a.pvKwh?b:a,null);
 const lowest=days.filter(d=>d.lowest).reduce((a,b)=>!a||b.lowest.soc<a.lowest.soc?b:a,null);
 const weeks=Object.values(days.reduce((out,d)=>{const date=new Date(d.date+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);const key=date.toISOString().slice(0,10);const w=out[key]??={start:key,pvKwh:0,gridHours:0,observedHours:0,days:0};w.pvKwh+=d.pvKwh;w.gridHours+=d.gridHours;w.observedHours+=d.gridKnownHours;w.days++;return out;},{}));
 return {days,heatmap,forecast,next,best:best?{date:best.date,pvKwh:best.pvKwh,coverageHours:best.coverageHours}:null,lowest:lowest?{date:lowest.date,...lowest.lowest}:null,weeks};
}
