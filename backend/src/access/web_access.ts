/** 프레임워크 중립 계정 저장소 + Fastify 브리지. 업무/Kubernetes 모듈은 참조하지 않는다. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import catalog from './page-catalog.json';
import loginTemplate from './login-template.json';
const derive = promisify(crypto.pbkdf2);
const pages: Record<string,string> = catalog.gimpo;
const PREFIX = '/velero';
type Role = 'admin'|'viewer';
type Account = { username:string; role:Role; pages:string[] };
type UserRow = Omit<Account,'pages'> & { pages:string; salt:string; password_hash:string; version:number };
type State={format:1;initialized:boolean;users:UserRow[];sessions:{hash:string;username:string;version:number;expires:number}[]};
export class AuthError extends Error { constructor(public statusCode:number,message:string){super(message);} }
function fail(status:number,message:string):never {throw new AuthError(status,message);}
function username(value:any):string {
 if(typeof value!=='string')return fail(400,'아이디를 입력하세요');
 const name=value.trim();if(!name||Array.from(name).length>128||/[\p{C}\s/%\\]/u.test(name))return fail(400,'아이디는 공백·경로 문자가 없는 1~128자로 입력하세요');return name;
}
function password(value:any):string {if(typeof value!=='string'||value.length<8||value.length>1024)return fail(400,'비밀번호는 8~1024자로 입력하세요');return value;}
function grants(role:any,value:any):string[]{
 if(role!=='admin'&&role!=='viewer')return fail(400,'역할이 올바르지 않습니다');
 if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||!Object.hasOwn(pages,x))||(role==='viewer'&&value.includes('users')))return fail(400,'허용되지 않은 페이지입니다');return [...new Set<string>(value)].sort();
}
function publicAccount(row:any):Account {
 if(!row)return fail(401,'로그인이 필요합니다');
 try{return {username:row.username,role:row.role,pages:grants(row.role,JSON.parse(row.pages))};}
 catch{return {username:row.username,role:'viewer',pages:[]};}
}
function allowed(account:Account,page:string):boolean {return Object.hasOwn(pages,page)&&(account.role==='admin'||page==='settings'||page!=='users'&&account.pages.includes(page));}
function sha(value:string){return crypto.createHash('sha256').update(value).digest('hex');}
async function hashed(value:string,salt:string){return (await derive(value,Buffer.from(salt,'hex'),390000,32,'sha256')).toString('hex');}
function same(a:string,b:string){return a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export async function verifyCangguAdmin(name:string,secret:string):Promise<void>{
 const base='http://canggu-hub.canggu-system.svc.cluster.local:8000/api/auth';
 async function call(endpoint:string,body?:object,token?:string):Promise<any>{
  try{
   const headers:Record<string,string>={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
   const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(5000)});
   if(response.status===401||response.status===403)return fail(403,'canggu 관리자 인증이 필요합니다');
   if(!response.ok)return fail(503,'canggu 관리자 확인을 완료하지 못했습니다');
   let size=0;const chunks:Uint8Array[]=[];if(!response.body)return fail(503,'관리자 확인 응답이 올바르지 않습니다');
   const reader=response.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)return fail(503,'관리자 확인 응답이 올바르지 않습니다');chunks.push(part.value);}}finally{await reader.cancel();}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){if(error instanceof AuthError)throw error;return fail(503,'canggu 관리자 확인을 완료하지 못했습니다');}
 }
 const login=await call('/login',{username:name,password:secret});
 if(typeof login.token!=='string'||!login.token||login.token.length>8192||!/^[A-Za-z0-9_.-]+$/.test(login.token))return fail(503,'관리자 확인 응답이 올바르지 않습니다');
 const current=await call('/me',undefined,login.token);
 if(current.role!=='admin'||typeof current.username!=='string'||!current.username)return fail(403,'canggu 관리자 계정이 필요합니다');
}
/** 단일 writer(Deployment replicas=1/Recreate)의 원자적 파일 저장소. NFS에서 WAL을 사용하지 않는다. */
export class AccountStore {
 private data:State={format:1,initialized:false,users:[],sessions:[]};
 constructor(private filename:string,private verifyAdmin=verifyCangguAdmin){
  if(filename!==':memory:'){
   fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
   if(fs.existsSync(filename)){
    const value=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(value?.format!==1||typeof value.initialized!=='boolean'||!Array.isArray(value.users)||!Array.isArray(value.sessions)||value.users.some((u:any)=>typeof u.username!=='string'||typeof u.salt!=='string'||typeof u.password_hash!=='string'||typeof u.version!=='number'))throw new Error('계정 저장 파일을 확인할 수 없습니다');
    this.data=value;
   }
   const probe=filename+'.writecheck-'+crypto.randomBytes(8).toString('hex'),renamed=probe+'.renamed';
   try{const fd=fs.openSync(probe,'wx',0o600);try{fs.writeFileSync(fd,'writecheck');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(probe,renamed);}
   finally{for(const candidate of [probe,renamed]){try{fs.unlinkSync(candidate);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
  }
 }
 close(){} // 매 변경을 즉시 영속화하며 열린 파일 핸들을 유지하지 않는다.
 private save(){
  if(this.filename===':memory:')return;
  const temp=this.filename+'.'+crypto.randomBytes(12).toString('hex')+'.tmp';let descriptor:number|undefined;
  try{
   descriptor=fs.openSync(temp,'wx',0o600);fs.writeFileSync(descriptor,JSON.stringify(this.data));fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
   fs.renameSync(temp,this.filename);
   // 일부 NFS 구현은 디렉터리 fsync를 제공하지 않는다. 파일 fsync와 rename은 필수이다.
   try{const dir=fs.openSync(path.dirname(this.filename),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}catch{}
  }catch(error){if(descriptor!==undefined)fs.closeSync(descriptor);try{fs.unlinkSync(temp);}catch{}throw error;}
 }
 private tx<T>(fn:()=>T):T{
  const previous=this.data;this.data=structuredClone(previous);
  try{const result=fn();this.save();return result;}catch(error){this.data=previous;throw error;}
 }
 private row(name:string):UserRow|undefined {const value=this.data.users.find(user=>user.username===name);return value?{...value}:undefined;}
 requiresBootstrap(){return !this.data.initialized&&this.data.users.length===0;}
 async bootstrap(body:any){
  const name=username(body?.username),secret=password(body?.password);if(secret!==body?.confirm_password)return fail(400,'새 비밀번호가 일치하지 않습니다');
  if(!this.requiresBootstrap())return fail(409,'최초 관리자 등록이 이미 완료되었습니다');
  if(typeof body?.canggu_username!=='string'||typeof body?.canggu_password!=='string'||!body.canggu_username||!body.canggu_password||body.canggu_username.length>128||body.canggu_password.length>4096)return fail(400,'canggu 관리자 인증이 필요합니다');
  await this.verifyAdmin(body.canggu_username,body.canggu_password);const salt=crypto.randomBytes(16).toString('hex'),digest=await hashed(secret,salt);
  this.tx(()=>{if(!this.requiresBootstrap())return fail(409,'최초 관리자 등록이 이미 완료되었습니다');this.data.initialized=true;this.data.users.push({username:name,salt,password_hash:digest,role:'admin',pages:'[]',version:0});});return {ok:true};
 }
 async login(name:any,secret:any){
  if(typeof name!=='string'||typeof secret!=='string'||name.length>128||secret.length>1024)return fail(401,'아이디 또는 비밀번호가 올바르지 않습니다');
  const row=this.row(name);if(!same(await hashed(secret,row?.salt??'00'.repeat(16)),row?.password_hash??'00'.repeat(32))||!row)return fail(401,'아이디 또는 비밀번호가 올바르지 않습니다');
  const token=crypto.randomBytes(32).toString('base64url');
  this.tx(()=>{const current=this.row(name);if(!current||current.version!==row.version||current.password_hash!==row.password_hash)return fail(401,'아이디 또는 비밀번호가 올바르지 않습니다');this.data.sessions=this.data.sessions.filter(session=>session.expires>Date.now());this.data.sessions.push({hash:sha(token),username:name,version:current.version,expires:Date.now()+7*86400000});});return token;
 }
 principal(token:string):Account {
  if(!token||token.length>256)return fail(401,'로그인이 필요합니다');const session=this.data.sessions.find(session=>session.hash===sha(token)&&session.expires>Date.now());
  const row=session?this.row(session.username):undefined;if(!session||!row||session.version!==row.version)return fail(401,'로그인이 필요합니다');return publicAccount(row);
 }
 summary(account:Account){return {...account,pages:Object.keys(pages).filter(page=>allowed(account,page)),availablePages:pages,canManageUsers:account.role==='admin',passwordMinLength:8};}
 list(){return this.data.users.map(publicAccount).sort((a,b)=>a.username.localeCompare(b.username));}
 async create(body:any){
  const name=username(body?.username),secret=password(body?.password),role=body?.role??'viewer',selected=grants(role,body?.pages??[]),salt=crypto.randomBytes(16).toString('hex'),digest=await hashed(secret,salt);
  this.tx(()=>{if(this.row(name))return fail(409,'이미 존재하는 사용자입니다');this.data.users.push({username:name,salt,password_hash:digest,role,pages:JSON.stringify(selected),version:0});});return {ok:true};
 }
 async edit(name:string,body:any){
  if(!body||typeof body!=='object'||Object.values(body).some(value=>value===null))return fail(400,'변경 값이 올바르지 않습니다');
  let salt:string|undefined,digest:string|undefined;if(body.password!==undefined){password(body.password);salt=crypto.randomBytes(16).toString('hex');digest=await hashed(body.password,salt);}
  this.tx(()=>{const row=this.row(name);if(!row)return fail(404,'사용자가 없습니다');const role=body.role??row.role,selected=grants(role,body.pages??JSON.parse(row.pages));
   if(row.role==='admin'&&role!=='admin'&&this.data.users.filter(user=>user.role==='admin').length<=1)return fail(409,'마지막 관리자는 강등할 수 없습니다');
   this.data.users=this.data.users.map(user=>user.username===name?{...user,role,pages:JSON.stringify(selected),salt:salt??user.salt,password_hash:digest??user.password_hash,version:user.version+(digest?1:0)}:user);
   if(digest)this.data.sessions=this.data.sessions.filter(session=>session.username!==name);
  });return {ok:true};
 }
 async changePassword(account:Account,body:any){
  const secret=password(body?.new_password);if(secret!==body?.confirm_password)return fail(400,'새 비밀번호가 일치하지 않습니다');
  const row=this.row(account.username);if(typeof body?.current_password!=='string'||body.current_password.length>1024||!row||!same(await hashed(body.current_password,row.salt),row.password_hash))return fail(403,'현재 비밀번호가 올바르지 않습니다');
  const salt=crypto.randomBytes(16).toString('hex'),digest=await hashed(secret,salt);
  this.tx(()=>{const current=this.row(account.username);if(!current||current.version!==row.version||current.password_hash!==row.password_hash)return fail(403,'현재 비밀번호가 변경되었습니다');this.data.users=this.data.users.map(user=>user.username===account.username?{...user,salt,password_hash:digest,version:user.version+1}:user);this.data.sessions=this.data.sessions.filter(session=>session.username!==account.username);});return {ok:true,reauthenticate:true};
 }
 logout(token:string){this.tx(()=>{this.data.sessions=this.data.sessions.filter(session=>session.hash!==sha(token));});}
}
export interface WebOptions {storePath?:string;prefix?:string;verifyAdmin?:(username:string,password:string)=>Promise<void>}
export function installWebAccess(app:FastifyInstance,options:WebOptions={}){
 const prefix=(options.prefix??process.env.WEB_BASE_PATH??PREFIX).replace(/\/$/,'');if(!/^(?:\/[\w-]+)*$/.test(prefix))throw new Error('Invalid WEB_BASE_PATH');
 const store=new AccountStore(options.storePath??process.env.WEB_ACCESS_STORE??path.resolve('.web-standard/accounts.json'),options.verifyAdmin);
 const cookie='ws_gimpo_session',cookiePath=prefix||'/';const attempts=new Map<string,number[]>();
 function token(request:FastifyRequest){return (request.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1)??'';}
 function rate(request:FastifyRequest){const now=Date.now();for(const [key,times] of attempts){const kept=times.filter(t=>now-t<60000);if(kept.length)attempts.set(key,kept);else attempts.delete(key);}const times=attempts.get(request.ip)??[];if(times.length>=10)return fail(429,'잠시 후 다시 시도하세요');times.push(now);attempts.set(request.ip,times);}
 function actor(request:FastifyRequest){return store.principal(token(request));}
 function admin(request:FastifyRequest){const a=actor(request);if(a.role!=='admin')return fail(403,'관리자 권한이 필요합니다');return a;}
 function next(account:Account){return prefix+'/'+(Object.keys(pages).find(p=>p!=='users'&&allowed(account,p))??'settings');}
 app.addHook('onClose',async()=>store.close());
 app.addHook('onRequest',async(request,reply)=>{
  const pathname=(request.raw.url??'/').split('?')[0];
  if(pathname.startsWith('/api/auth/')){reply.header('Cache-Control','no-store');if(request.method!=='GET'&&request.headers.origin){try{if(new URL(request.headers.origin).host!==request.headers.host)return reply.code(403).send({detail:'요청 출처가 올바르지 않습니다'});}catch{return reply.code(403).send({detail:'요청 출처가 올바르지 않습니다'});}}}
  if(['/healthz','/login','/api/auth/status','/api/auth/bootstrap','/api/auth/login','/ws-login.css','/ws-theme.js','/favicon.ico'].includes(pathname)||pathname.startsWith('/assets/'))return;
  let account:Account;try{account=actor(request);}catch(error){if(pathname.startsWith('/api/'))return reply.code(401).send({detail:'로그인이 필요합니다'});return reply.redirect(prefix+'/login');}
  if(account.role==='admin')return;
  if(pathname==='/')return reply.redirect(next(account));
  const required=requiredPages(pathname);
  if(!required.some(p=>allowed(account,p)))return reply.code(403).send({detail:'이 페이지에 접근할 권한이 없습니다'});
  if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!['/api/auth/logout','/api/auth/ui/password'].includes(pathname))return reply.code(403).send({detail:'관리자 권한이 필요합니다'});
 });
 async function handle(reply:any,action:()=>any){try{return await action();}catch(error){if(error instanceof AuthError)return reply.code(error.statusCode).send({detail:error.message});throw error;}}
 app.get('/login',async(request,reply)=>{try{return reply.redirect(next(actor(request)));}catch{return reply.type('text/html').header('Cache-Control','no-store').send(loginTemplate.replaceAll('__PREFIX__',prefix));}});
 app.get('/api/auth/status',async()=>({bootstrapRequired:store.requiresBootstrap()}));
 app.post('/api/auth/bootstrap',async(request,reply)=>handle(reply,()=>{rate(request);return store.bootstrap(request.body);}));
 app.post('/api/auth/login',async(request,reply)=>handle(reply,async()=>{rate(request);const body=request.body as any;const value=await store.login(body?.username,body?.password);reply.header('Set-Cookie',`${cookie}=${value}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=604800${request.protocol==='https'||request.headers['x-forwarded-proto']==='https'?'; Secure':''}`);return {ok:true,next:next(store.principal(value))};}));
 app.get('/api/auth/ui/session',async(request,reply)=>handle(reply,()=>store.summary(actor(request))));
 app.post('/api/auth/ui/password',async(request,reply)=>handle(reply,()=>store.changePassword(actor(request),request.body)));
 app.get('/api/auth/users',async(request,reply)=>handle(reply,()=>{admin(request);return store.list();}));
 app.post('/api/auth/users',async(request,reply)=>handle(reply,()=>{admin(request);return store.create(request.body);}));
 app.patch<{Params:{username:string}}>('/api/auth/users/:username',async(request,reply)=>handle(reply,()=>{admin(request);return store.edit(request.params.username,request.body);}));
 app.post('/api/auth/logout',async(request,reply)=>handle(reply,()=>{store.logout(token(request));reply.header('Set-Cookie',`${cookie}=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`);return {ok:true};}));
 return store;
}
export function requiredPages(pathname:string):string[]{
 if(pathname.startsWith('/api/auth/users'))return ['users'];
 if(pathname.startsWith('/api/auth/')||pathname==='/settings')return ['settings'];
 if(pathname==='/api/overview'||pathname==='/api/overview/health'||pathname==='/api/server-status')return ['overview'];
 if(pathname.startsWith('/api/health/')||pathname.startsWith('/api/restore-test'))return ['health'];
 if(pathname.startsWith('/api/backups'))return ['backups'];
 if(pathname.startsWith('/api/restores'))return ['restores'];
 if(pathname.startsWith('/api/schedules')||pathname.startsWith('/api/cron/'))return ['schedules'];
 if(pathname.startsWith('/api/backup-storage-locations')||pathname.startsWith('/api/volume-snapshot-locations'))return ['storage'];
 if(/^\/api\/(backup-repositories|pod-volume-backups|pod-volume-restores|data-uploads|data-downloads)/.test(pathname))return ['repositories','backups','restores'];
 if(pathname==='/api/namespaces'||pathname==='/api/api-resources')return ['backups','restores','schedules'];
 const page=pathname.replace(/^\//,'').split('/')[0];return Object.hasOwn(pages,page)?[page]:[];
}
