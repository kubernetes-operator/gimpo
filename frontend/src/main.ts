import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import './styles.css';
import './web-standard.css';
import './web-standard-auth.js';

import { refreshAccess } from './web-access';

async function bootstrap() {
  await refreshAccess();
  const app = createApp(App);

  // Element Plus 아이콘 전역 등록
  for (const [name, comp] of Object.entries(ElementPlusIconsVue)) {
    app.component(name, comp as never);
  }

  app.use(createPinia());
  app.use(router);
  app.use(ElementPlus);
  app.mount('#app');
}
bootstrap().catch(() => {
  const root=document.getElementById('app');
  if(root){const message=document.createElement('p');message.textContent='계정 권한을 확인하지 못했습니다. 새로고침 후 다시 시도하세요.';root.replaceChildren(message);}
});
