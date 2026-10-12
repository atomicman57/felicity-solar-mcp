export function powerRecord(samples, limit=1440) {
 const hours=Array.from({length:24},()=>({on:0,off:0,unknown:60,slots:Array(12).fill(null)}));
 const windows=[];let window=null;
 for(const s of samples){
  const duration=Math.max(0,Math.min(5,limit-s.minute));if(!duration)continue;
  const cell=hours[Math.floor(s.minute/60)];
  if(s.gridOn===null||s.gridOn===undefined){window=null;continue;}
  cell.unknown-=duration;cell[s.gridOn?'on':'off']+=duration;cell.slots[Math.floor((s.minute%60)/5)]={on:s.gridOn,duration};
  if(s.gridOn){if(!window||window.end!==s.minute){window={start:s.minute,end:s.minute+duration};windows.push(window);}else window.end=s.minute+duration;}else window=null;
 }
 return {hours,windows};
}
