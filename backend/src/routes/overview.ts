/** 개요 페이지는 집계/최근 8개 표시 필드만 읽는다. 상세 리소스 권한을 대신하지 않는다. */
import type { FastifyInstance } from 'fastify';
import { velero, PLURALS } from '../k8s/velero';
import { getHealthReport } from './health';
export default async function overviewRoutes(app:FastifyInstance){
 app.get('/api/overview',async()=>{
  const errors:string[]=[];
  async function list(plural:string,label:string):Promise<any[]>{try{return (await velero.list(plural)).items??[];}catch{errors.push(label);return [];}}
  const [backups,restores,schedules,storage]=await Promise.all([list(PLURALS.backups,'백업'),list(PLURALS.restores,'복구'),list(PLURALS.schedules,'스케줄'),list(PLURALS.backupStorageLocations,'스토리지')]);
  const count=(rows:any[],phase:string)=>rows.filter(row=>row.status?.phase===phase).length;
  const recent=[...backups].sort((a,b)=>(b.metadata?.creationTimestamp??'').localeCompare(a.metadata?.creationTimestamp??'')).slice(0,8).map(row=>({metadata:{name:row.metadata?.name,creationTimestamp:row.metadata?.creationTimestamp},status:{phase:row.status?.phase}}));
  return {backups:{total:backups.length,completed:count(backups,'Completed'),recent},restores:{total:restores.length,completed:count(restores,'Completed')},schedules:{total:schedules.length},storage:{total:storage.length,available:count(storage,'Available')},errors};
 });
 app.get('/api/overview/health',async()=>{const report=await getHealthReport();return {overall:report.overall,counts:report.counts};});
}
