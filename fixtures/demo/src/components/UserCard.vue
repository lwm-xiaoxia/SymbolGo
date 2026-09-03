<template>
  <section class="user-card" :class="{ 'is-active': active }">
    <h3 class="user-card__title">{{ title }}</h3>
    <p class="user-card__desc">描述</p>
  </section>
</template>

<script setup>
defineProps({ title: String, active: Boolean });
</script>

<style lang="scss" scoped>
@use "../styles/variables" as vars;

.user-card {
  padding: vars.$gap;

  &__title {
    color: vars.$primary;
  }

  &__desc {
    animation: fade-in 200ms;
  }

  &.is-active {
    outline: 1px solid vars.$primary;
  }
}
</style>
