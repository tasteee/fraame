import type { JSX } from 'solid-js'

type ZestElementT = JSX.HTMLAttributes<HTMLElement> & Record<string, unknown>

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'z-stack': ZestElementT
      'z-center': ZestElementT
      'z-card': ZestElementT
      'z-surface': ZestElementT
      'z-text': ZestElementT
      'z-heading': ZestElementT
      'z-display': ZestElementT
      'z-button': ZestElementT
      'z-link': ZestElementT
      'z-slider': ZestElementT
      'z-progress': ZestElementT
      'z-alert': ZestElementT
      'z-badge': ZestElementT
    }
  }
}
