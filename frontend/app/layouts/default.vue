<template>
  <B24SidebarLayout :use-light-content="false">
    <!-- Content -->
    <slot />
    <HelpGuide />
    <AppToasts />
  </B24SidebarLayout>
</template>
