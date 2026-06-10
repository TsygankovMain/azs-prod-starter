<script setup lang="ts">
// AppToasts renders the b24ui Toaster in the bottom-right corner.
// It is placed at the end of every layout's template so toasts are
// always visible regardless of scroll position (B24Toaster uses a portal).
// Duration and colour per-toast are driven by useToast().success/error/info.
</script>

<template>
  <B24Toaster position="bottom-right" />
</template>
