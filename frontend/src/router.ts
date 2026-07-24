import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
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
