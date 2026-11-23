import { createRouter, createWebHistory } from 'vue-router';
import { watch } from 'vue';
import { webAccess } from './web-access';

const router = createRouter({
  // 서브패스 서빙 대응: 빌드 시 주입된 base(예: /velero/)를 라우터 base 로 사용
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/overview' },
    { path:'/settings',name:'settings',component:()=>import('./views/SettingsView.vue') },
    { path: '/overview', name: 'overview', component: () => import('./views/OverviewView.vue') },
    { path: '/health', name: 'health', component: () => import('./views/HealthView.vue') },
    { path: '/backups', name: 'backups', component: () => import('./views/BackupsView.vue') },
    { path: '/restores', name: 'restores', component: () => import('./views/RestoresView.vue') },
    { path: '/schedules', name: 'schedules', component: () => import('./views/SchedulesView.vue') },
    { path: '/storage', name: 'storage', component: () => import('./views/StorageView.vue') },
    { path: '/repositories', name: 'repositories', component: () => import('./views/RepositoriesView.vue') },
  ],
});

router.beforeEach(to=>{const name=String(to.name||'');if(webAccess.pages.includes(name))return true;return {name:webAccess.pages.find(page=>page!=='users')||'settings',replace:true};});
watch(()=>webAccess.pages,()=>{const name=String(router.currentRoute.value.name||'');if(name&&!webAccess.pages.includes(name))void router.replace({name:webAccess.pages.find(page=>page!=='users')||'settings'});});

export default router;
