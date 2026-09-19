// @vitest-environment jsdom
// Message speak action: reads the message aloud, hidden without a handler.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageIconActions } from '../src/client/chat/MessageIconActions.tsx'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'

afterEach(cleanup)

const t = ((key: string): string => key) as ChatViewSlotProps['t']

describe('MessageIconActions speak', () => {
  it('reads the message aloud through onSpeak', () => {
    const onSpeak = vi.fn()
    render(<MessageIconActions text="hello" clock="end" onSpeak={onSpeak} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'message.speak' }))
    expect(onSpeak).toHaveBeenCalledTimes(1)
  })

  it('hides the speak action without a handler', () => {
    render(<MessageIconActions text="hello" clock="end" t={t} />)
    expect(screen.queryByRole('button', { name: 'message.speak' })).toBeNull()
  })
})
