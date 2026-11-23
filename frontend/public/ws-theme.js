/* 선택적 테마 동작. 업무 데이터/계정 저장소와 별도 키를 사용한다. */
(function () {
  'use strict';
  var key = 'web-standard:theme';
  var choices = ['system', 'light', 'dark'];
  function apply(value, persist) {
    if (choices.indexOf(value) < 0) value = 'system';
    var root = document.documentElement;
    root.classList.toggle('ws-theme-light', value === 'light');
    root.classList.toggle('ws-theme-dark', value === 'dark');
    root.setAttribute('data-ws-theme', value);
    if (persist) { try { localStorage.setItem(key, value); } catch (_) {} }
    document.querySelectorAll('[data-ws-theme-select]').forEach(function (el) { el.value = value; });
  }
  var initial = 'system';
  try { initial = localStorage.getItem(key) || initial; } catch (_) {}
  apply(initial, false);
  document.addEventListener('DOMContentLoaded', function () { apply(document.documentElement.getAttribute('data-ws-theme') || initial, false); }, { once: true });
  document.addEventListener('change', function (event) {
    if (event.target.matches('[data-ws-theme-select]')) apply(event.target.value, true);
  });
  window.addEventListener('storage', function (event) { if (event.key === key) apply(event.newValue, false); });
}());
