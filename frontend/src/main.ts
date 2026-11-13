import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import './styles.css';

const app = createApp(App);

// Element Plus 아이콘 전역 등록
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, comp as never);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus);
app.mount('#app');
