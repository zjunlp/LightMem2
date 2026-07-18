<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import HomeLayout from './components/HomeLayout.vue'

const { page } = useData()
</script>

<template>
  <HomeLayout v-if="page.relativePath === 'index.md'" />
  <DefaultTheme.Layout v-else />
</template>
