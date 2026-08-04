<template>
  <span v-if="props.name === 'repeat-1'" class="app-icon app-icon--repeat-one" aria-hidden="true">
    <FontAwesomeIcon :icon="faRepeat" />
    <span>1</span>
  </span>
  <FontAwesomeIcon v-else-if="icon" class="app-icon" :icon="icon" aria-hidden="true" />
</template>

<script setup lang="ts">
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faHeart as faHeartRegular } from '@fortawesome/free-regular-svg-icons'
import {
  faAngleLeft,
  faAngleRight,
  faArrowUp,
  faBackwardStep,
  faCalendarDays,
  faCaretDown,
  faCheck,
  faChevronDown,
  faChevronUp,
  faCircleExclamation,
  faClockRotateLeft,
  faCompactDisc,
  faEllipsis,
  faForwardStep,
  faGear,
  faHeart as faHeartSolid,
  faList,
  faLock,
  faMagnifyingGlass,
  faMicrophone,
  faPause,
  faPlay,
  faPlus,
  faRepeat,
  faRightFromBracket,
  faRightToBracket,
  faShuffle,
  faVolumeHigh,
  faVolumeXmark,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'

const props = defineProps<{ name: string }>()

const iconByName: Readonly<Record<string, IconDefinition>> = {
  album: faCompactDisc,
  'arrow-down': faChevronDown,
  'arrow-left': faAngleLeft,
  'arrow-right': faAngleRight,
  'arrow-up-alt': faArrowUp,
  'arrow-up': faChevronUp,
  artist: faMicrophone,
  calendar: faCalendarDays,
  check: faCheck,
  dropdown: faCaretDown,
  explicit: faCircleExclamation,
  heart: faHeartRegular,
  'heart-solid': faHeartSolid,
  history: faClockRotateLeft,
  list: faList,
  lock: faLock,
  login: faRightToBracket,
  logout: faRightFromBracket,
  more: faEllipsis,
  next: faForwardStep,
  pause: faPause,
  play: faPlay,
  plus: faPlus,
  previous: faBackwardStep,
  repeat: faRepeat,
  search: faMagnifyingGlass,
  settings: faGear,
  shuffle: faShuffle,
  volume: faVolumeHigh,
  'volume-mute': faVolumeXmark,
  x: faXmark,
}

const icon = computed(() => iconByName[props.name])
</script>

<style scoped>
.app-icon {
  display: inline-flex;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  color: currentColor;
}

.app-icon--repeat-one {
  position: relative;
  align-items: center;
  justify-content: center;
}

.app-icon--repeat-one :deep(svg) {
  width: 100%;
  height: 100%;
}

.app-icon--repeat-one > span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 0.46em;
  font-weight: 600;
  line-height: 1;
  transform: translateY(-0.03em);
}
</style>
