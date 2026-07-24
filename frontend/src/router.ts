import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  // 서브패스 서빙 대응: 빌드 시 주입된 base(예: /velero/)를 라우터 base 로 사용
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('./views/OverviewView.vue') },
    { path: '/backups', name: 'backups', component: () => import('./views/BackupsView.vue') },
    { path: '/restores', name: 'restores', component: () => import('./views/RestoresView.vue') },
    { path: '/schedules', name: 'schedules', component: () => import('./views/SchedulesView.vue') },
    { path: '/storage', name: 'storage', component: () => import('./views/StorageView.vue') },
    { path: '/repositories', name: 'repositories', component: () => import('./views/RepositoriesView.vue') },
  ],
});

export default router;
