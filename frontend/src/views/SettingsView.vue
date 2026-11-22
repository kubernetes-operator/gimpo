<template><div><h2>개인 설정</h2><p>현재 비밀번호를 확인한 후 새 비밀번호를 변경할 수 있습니다.</p><el-button @click="open">개인 설정 열기</el-button></div></template>
<script setup lang="ts">
function open(){(window as any).WSSettings.open('personal');}
</script>
