import { reactive } from 'vue';
import { http } from './api/client';
export const webAccess=reactive<{role:'admin'|'viewer';pages:string[]}>({role:'viewer',pages:[]});
export async function refreshAccess(){
 const {data}=await http.get('/auth/ui/session');
 if(!data||!['admin','viewer'].includes(data.role)||!Array.isArray(data.pages))throw new Error('계정 권한 응답을 확인할 수 없습니다');
 webAccess.role=data.role;webAccess.pages=data.pages;
}
document.addEventListener('ws:settings:ready',()=>{const sdk=(window as any).WSSettings;if(sdk&&['admin','viewer'].includes(sdk.role)&&Array.isArray(sdk.pages)){webAccess.role=sdk.role;webAccess.pages=[...sdk.pages];}});
