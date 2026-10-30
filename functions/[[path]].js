// AL Formula 1 News — API (Cloudflare Pages Function). Bindings: DB (D1), IMAGES (R2), ADMIN_PASSWORD (secret)
const J=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
const LB={FirstPractice:"Практика 1",SecondPractice:"Практика 2",ThirdPractice:"Практика 3",SprintQualifying:"Спринт-кваліфікація",Sprint:"Спринт",Qualifying:"Кваліфікація"};
const iso=o=>o&&o.date?o.date+"T"+(o.time||"12:00:00Z"):null;

async function jget(url,ctx){
  const cache=caches.default,req=new Request(url);
  let r=await cache.match(req);
  if(!r){
    r=await fetch(url,{headers:{"user-agent":"alformula1news"}});
    if(!r.ok)throw new Error("f1 api "+r.status);
    r=new Response(r.body,r);r.headers.set("cache-control","public,max-age=300");
    ctx.waitUntil(cache.put(req,r.clone()));
  }
  return r.json();
}

async function f1(ctx){
  const B="https://api.jolpi.ca/ergast/f1/current";
  const [d,c,s]=await Promise.all([jget(B+"/driverStandings.json",ctx),jget(B+"/constructorStandings.json",ctx),jget(B+".json?limit=40",ctx)]);
  const dl=(d.MRData.StandingsTable.StandingsLists[0]||{}).DriverStandings||[];
  const cl=(c.MRData.StandingsTable.StandingsLists[0]||{}).ConstructorStandings||[];
  return{
    drivers:dl.map(x=>({name:x.Driver.givenName+" "+x.Driver.familyName,team:(x.Constructors[x.Constructors.length-1]||{}).name||"",pts:+x.points})),
    constructors:cl.map(x=>({name:x.Constructor.name,pts:+x.points})),
    races:s.MRData.RaceTable.Races.map(r=>{
      const ss=[];for(const k in LB){const t=iso(r[k]);if(t)ss.push([LB[k],t])}
      const t=iso(r);if(t)ss.push(["Гонка",t]);
      ss.sort((a,b)=>Date.parse(a[1])-Date.parse(b[1]));
      return{n:r.raceName,s:ss};
    })
  };
}

export async function onRequest(ctx){
  const {request:rq,env}=ctx,u=new URL(rq.url),m=rq.method;
  const p=u.pathname.replace(/^\/api\/?/,"").split("/").filter(Boolean);
  const adm=!!env.ADMIN_PASSWORD&&rq.headers.get("x-admin")===env.ADMIN_PASSWORD;
  try{
    if(p[0]==="f1"&&m==="GET")return J(await f1(ctx));
    if(p[0]==="login"&&m==="POST")return adm?J({ok:1}):J({error:"auth"},401);

    if(p[0]==="img"&&m==="GET"){
      const o=await env.IMAGES.get(p.slice(1).join("/"));
      if(!o)return new Response("",{status:404});
      return new Response(o.body,{headers:{"content-type":(o.httpMetadata&&o.httpMetadata.contentType)||"image/jpeg","cache-control":"public,max-age=31536000,immutable"}});
    }
    if(p[0]==="upload"&&m==="POST"){
      if(!adm)return J({error:"auth"},401);
      const t=rq.headers.get("content-type")||"";
      if(!/^image\/(jpeg|png|webp|gif)$/.test(t))return J({error:"type"},400);
      const b=await rq.arrayBuffer();
      if(b.byteLength>10485760)return J({error:"size"},413);
      const k=crypto.randomUUID();
      await env.IMAGES.put(k,b,{httpMetadata:{contentType:t}});
      return J({key:k});
    }
    if(p[0]==="posts"){
      if(!p[1]){
        if(m==="GET"){
          const r=await env.DB.prepare("SELECT id,title,substr(text,1,300) AS text,img,ts FROM posts ORDER BY ts DESC LIMIT 50").all();
          return J(r.results);
        }
        if(m==="POST"){
          if(!adm)return J({error:"auth"},401);
          const b=await rq.json();
          const t=String(b.title||"").trim().slice(0,200),x=String(b.text||"").trim().slice(0,50000);
          const img=/^[0-9a-f-]{36}$/.test(b.img||"")?b.img:null;
          if(!t||!x)return J({error:"empty"},400);
          const r=await env.DB.prepare("INSERT INTO posts(title,text,img,ts) VALUES(?,?,?,?)").bind(t,x,img,Date.now()).run();
          return J({id:r.meta.last_row_id});
        }
      }else{
        const id=parseInt(p[1],10);if(!id)return J({error:"id"},400);
        if(!p[2]){
          if(m==="GET"){
            const r=await env.DB.prepare("SELECT id,title,text,img,ts FROM posts WHERE id=?").bind(id).first();
            return r?J(r):J({error:"nf"},404);
          }
          if(m==="DELETE"){
            if(!adm)return J({error:"auth"},401);
            const r=await env.DB.prepare("SELECT img FROM posts WHERE id=?").bind(id).first();
            await env.DB.batch([env.DB.prepare("DELETE FROM comments WHERE post_id=?").bind(id),env.DB.prepare("DELETE FROM posts WHERE id=?").bind(id)]);
            if(r&&r.img)await env.IMAGES.delete(r.img);
            return J({ok:1});
          }
        }else if(p[2]==="comments"){
          if(m==="GET"){
            const r=await env.DB.prepare("SELECT id,name,text,ts FROM comments WHERE post_id=? ORDER BY ts ASC LIMIT 300").bind(id).all();
            return J(r.results);
          }
          if(m==="POST"){
            const b=await rq.json();
            if(b.website)return J({ok:1}); // honeypot
            const n=String(b.name||"").trim().slice(0,40),t=String(b.text||"").trim().slice(0,1000);
            if(!n||!t)return J({error:"empty"},400);
            const ip=rq.headers.get("cf-connecting-ip")||"";
            const c=await env.DB.prepare("SELECT COUNT(*) AS c FROM comments WHERE ip=? AND ts>?").bind(ip,Date.now()-600000).first();
            if(c&&c.c>=5)return J({error:"rate"},429);
            const ex=await env.DB.prepare("SELECT id FROM posts WHERE id=?").bind(id).first();
            if(!ex)return J({error:"nf"},404);
            await env.DB.prepare("INSERT INTO comments(post_id,name,text,ip,ts) VALUES(?,?,?,?,?)").bind(id,n,t,ip,Date.now()).run();
            return J({ok:1});
          }
        }
      }
    }
    if(p[0]==="comments"&&p[1]&&m==="DELETE"){
      if(!adm)return J({error:"auth"},401);
      await env.DB.prepare("DELETE FROM comments WHERE id=?").bind(parseInt(p[1],10)).run();
      return J({ok:1});
    }
  }catch(e){return J({error:"server"},500)}
  return J({error:"not found"},404);
}
