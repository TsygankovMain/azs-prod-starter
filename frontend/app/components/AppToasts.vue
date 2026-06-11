<script setup lang="ts">
// AppToasts renders the b24ui Toaster in the bottom-right corner.
// It is mounted once in app.vue (not per-layout) so there is always exactly
// one Toaster instance for the whole application (B24Toaster uses a portal).
// Duration and colour per-toast are driven by useAppToast().success/error/info.
</script>

<template>
  <B24Toaster position="bottom-right" />
</template>
