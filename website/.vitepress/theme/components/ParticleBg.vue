<template>
  <canvas ref="canvas" class="starfield-canvas" aria-hidden="true"></canvas>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvas = ref<HTMLCanvasElement>()

const LAYERS = [
  { count: 700, speed: 0.06, minR: 0.3, maxR: 0.8, alpha: 0.80, twinkle: false },
  { count: 200, speed: 0.15, minR: 0.6, maxR: 1.6, alpha: 0.90, twinkle: true },
  { count: 50,  speed: 0.25, minR: 1.2, maxR: 2.6, alpha: 1.0,  twinkle: true, glow: true },
]

interface Star {
  x: number; y: number; r: number; baseR: number
  alpha: number; baseAlpha: number
  color: string
  phase: number; freq: number
  glowColor?: string
}

let ctx: CanvasRenderingContext2D
let stars: Star[] = []
let mouse = { x: 0.5, y: 0.5 }
let animId = 0
let w = 0; let h = 0
let time = 0

const STAR_COLORS = [
  '#ffffff', '#f8f9ff', '#eef0ff',
  '#C4B5FD', '#ddd6fe',           // warm violet
  '#A5F3FC', '#CFFAFE',           // cool cyan
  '#BFDBFE', '#DBEAFE',           // soft blue
]

function pick<T>(arr: T[]) { return arr[Math.floor(Math.random() * arr.length)] }

function resize() {
  if (!canvas.value) return
  w = window.innerWidth
  h = window.innerHeight
  canvas.value.width = w
  canvas.value.height = h
}

function createStars() {
  stars = []
  for (const layer of LAYERS) {
    for (let i = 0; i < layer.count; i++) {
      const baseR = layer.minR + Math.random() * (layer.maxR - layer.minR)
      const baseAlpha = layer.alpha * (0.6 + Math.random() * 0.4)
      const color = pick(STAR_COLORS)
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: baseR, baseR,
        alpha: baseAlpha, baseAlpha,
        color,
        phase: Math.random() * Math.PI * 2,
        freq: 0.3 + Math.random() * 1.2,
        glowColor: layer.glow ? color : undefined,
        _layer: layer,
      } as Star & { _layer: typeof layer })
    }
  }
}

function draw() {
  if (!ctx || !canvas.value) return
  ctx.clearRect(0, 0, w, h)
  time += 0.005

  // Parallax: mouse position shifts each layer at different rates
  const mx = (mouse.x - 0.5) * 50
  const my = (mouse.y - 0.5) * 50

  for (const s of stars) {
    const layer = (s as any)._layer

    // Parallax drift
    s.x += layer.speed * mx * 0.005
    s.y += layer.speed * my * 0.005

    // Wrap around edges
    if (s.x < -10) s.x = w + 10
    if (s.x > w + 10) s.x = -10
    if (s.y < -10) s.y = h + 10
    if (s.y > h + 10) s.y = -10

    // Twinkle
    if (layer.twinkle) {
      const twinkle = 0.35 + 0.65 * Math.sin(time * s.freq + s.phase)
      s.alpha = s.baseAlpha * twinkle
      s.r = s.baseR * (0.65 + 0.35 * twinkle)
    }

    // Glow halo for largest stars
    if (layer.glow) {
      const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 6)
      glow.addColorStop(0, s.glowColor!)
      glow.addColorStop(0.3, s.glowColor!)
      glow.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r * 6, 0, Math.PI * 2)
      ctx.fillStyle = glow
      ctx.globalAlpha = s.alpha * 0.55
      ctx.fill()
    }

    // Star dot
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fillStyle = s.color
    ctx.globalAlpha = s.alpha
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Drift mouse back to center
  mouse.x += (0.5 - mouse.x) * 0.003
  mouse.y += (0.5 - mouse.y) * 0.003

  animId = requestAnimationFrame(draw)
}

function onMouseMove(e: MouseEvent) {
  mouse.x = e.clientX / w
  mouse.y = e.clientY / h
}

onMounted(() => {
  resize()
  createStars()
  if (canvas.value) {
    ctx = canvas.value.getContext('2d')!
    draw()
  }
  window.addEventListener('resize', () => { resize(); createStars() })
  window.addEventListener('mousemove', onMouseMove)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animId)
  window.removeEventListener('resize', resize)
  window.removeEventListener('mousemove', onMouseMove)
})
</script>

<style scoped>
.starfield-canvas {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 1.0;
}
</style>
