// @vitest-environment jsdom
// ScreenSection template: renders every feature card, persists the draft, and
// reports the save.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { ScreenSettingsKey } from '../src/client/locales.ts'
import { ScreenSection } from '../src/client/ScreenSection.tsx'
import type { ScreenSectionProps } from '../src/client/ScreenSection.tsx'
import { DEFAULT_SCREEN_SETTINGS, readScreenSettings } from '../src/client/screen-settings.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const t = (key: ScreenSettingsKey): string => zh[key]

function renderSection() {
  return render(<ScreenSection {...{ t } as unknown as ScreenSectionProps} />)
}

describe('ScreenSection', () => {
  it('renders every feature card', () => {
    const view = renderSection()
    for (const title of [
      zh['broadcast.title'], zh['interval.title'], zh['preview.title'], zh['quality.title'],
      zh['buffer.title'], zh['smart.title'], zh['scope.title'], zh['text.title'], zh['audio.title'],
      zh['stop.title'],
    ]) {
      // The card <section> precedes its inner radiogroup in DOM order.
      expect(view.getAllByLabelText(title)[0]?.tagName).toBe('SECTION')
    }
  })

  it('lists the offered preview corners and resolutions', () => {
    const view = renderSection()
    for (const key of ['preview.top-left', 'preview.top-right', 'preview.bottom-left', 'preview.bottom-right'] as const) {
      expect(view.getByLabelText(zh[key])).toBeTruthy()
    }
    for (const key of ['quality.edge.854', 'quality.edge.1280', 'quality.edge.1920'] as const) {
      expect(view.getByLabelText(zh[key])).toBeTruthy()
    }
  })

  it('saves every group and reports the save', () => {
    const view = renderSection()
    const preview = within(view.getAllByLabelText(zh['preview.title'])[0]!)
    const quality = within(view.getAllByLabelText(zh['quality.title'])[0]!)
    act(() => {
      fireEvent.click(preview.getByLabelText(zh['preview.top-left']))
      fireEvent.click(quality.getByLabelText(zh['quality.edge.1920']))
      fireEvent.click(view.getByLabelText(zh['audio.capture']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    const stored = readScreenSettings()
    expect(stored.broadcast).toBe(true)
    expect(stored.showPreview).toBe(true)
    expect(stored.previewCorner).toBe('top-left')
    expect(stored.maxEdge).toBe(1920)
    expect(stored.captureAudio).toBe(true)
    expect(view.getByRole('status').textContent).toBe(zh['saved'])
  })

  it('turns the preview window off through its own switch', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['preview.show']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().showPreview).toBe(false)
  })

  it('turns the broadcast off and stores the single-frame choice', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['broadcast.off']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().broadcast).toBe(false)
  })

  it('moves the interval slider and stores the chosen cadence', () => {
    const view = renderSection()
    const slider = view.getByRole('slider', { name: /画面间隔/ }) as HTMLInputElement
    act(() => {
      fireEvent.change(slider, { target: { value: '9000' } })
    })
    expect(view.getByText(zh['interval.value'].replace('{ms}', '9000'))).toBeTruthy()
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().intervalMs).toBe(9000)
  })

  it('disables the interval slider while the broadcast is off', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['broadcast.off']))
    })
    expect((view.getByRole('slider', { name: /画面间隔/ }) as HTMLInputElement).disabled).toBe(true)
  })

  it('stores the JPEG quality chosen on the slider', () => {
    const view = renderSection()
    const slider = view.getByRole('slider', { name: zh['quality.quality'] }) as HTMLInputElement
    act(() => {
      fireEvent.change(slider, { target: { value: '0.6' } })
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().quality).toBeCloseTo(0.6, 5)
  })

  it('flips the end-behavior label with the stored choice', () => {
    const view = renderSection()
    expect(view.getByText(zh['stop.onended'])).toBeTruthy()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['stop.onended']))
    })
    expect(view.getByText(zh['stop.onended.off'])).toBeTruthy()
  })

  it('stores the smart-send switch and its threshold', () => {
    const view = renderSection()
    const slider = view.getByRole('slider', { name: /变化灵敏度/ }) as HTMLInputElement
    act(() => {
      fireEvent.click(view.getByLabelText(zh['smart.on']))
      fireEvent.change(slider, { target: { value: '0.05' } })
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    const stored = readScreenSettings()
    expect(stored.sendOnChange).toBe(true)
    expect(stored.changeThreshold).toBeCloseTo(0.05, 5)
  })

  it('disables the threshold slider until smart send is on', () => {
    const view = renderSection()
    const slider = () => view.getByRole('slider', { name: /变化灵敏度/ }) as HTMLInputElement
    expect(slider().disabled).toBe(true)
    act(() => {
      fireEvent.click(view.getByLabelText(zh['smart.on']))
    })
    expect(slider().disabled).toBe(false)
  })

  it('prints the threshold percentage without collapsing the low end to zero', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['smart.on']))
    })
    const slider = view.getByRole('slider', { name: /变化灵敏度/ }) as HTMLInputElement
    // The range starts at 0.1%; whole-number rounding would print "0" for every
    // step below 0.5% and leave the label indistinguishable across that span.
    for (const [value, expected] of [['0.001', '0.1'], ['0.005', '0.5'], ['0.015', '1.5'], ['0.2', '20']] as const) {
      act(() => {
        fireEvent.change(slider, { target: { value } })
      })
      expect(view.getByText(zh['smart.threshold.value'].replace('{percent}', expected))).toBeTruthy()
    }
  })

  it('offers every capture scope and stores the chosen one', () => {
    const view = renderSection()
    for (const key of ['scope.ask', 'scope.screen', 'scope.window'] as const) {
      expect(view.getByLabelText(zh[key])).toBeTruthy()
    }
    act(() => {
      fireEvent.click(view.getByLabelText(zh['scope.window']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().captureScope).toBe('window')
  })

  it('stores the text-instead-of-picture switch', () => {
    const view = renderSection()
    act(() => {
      fireEvent.click(view.getByLabelText(zh['text.on']))
    })
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    expect(readScreenSettings().sendText).toBe(true)
  })

  it('carries the three buffer limits from their sliders to the stored document', () => {
    const view = renderSection()
    const frames = view.getByRole('slider', { name: zh['buffer.frames'] }) as HTMLInputElement
    const size = view.getByRole('slider', { name: zh['buffer.size'] }) as HTMLInputElement
    const text = view.getByRole('slider', { name: zh['buffer.text'] }) as HTMLInputElement
    act(() => {
      fireEvent.change(frames, { target: { value: '20' } })
      fireEvent.change(size, { target: { value: String(6 * 1024 * 1024) } })
      fireEvent.change(text, { target: { value: '45000' } })
    })
    // The label echoes the choice before the save, so the page never shows a
    // number the document will not hold.
    expect(view.getByText(zh['buffer.frames.value'].replace('{count}', '20'))).toBeTruthy()
    expect(view.getByText(zh['buffer.size.value'].replace('{mb}', '6'))).toBeTruthy()
    expect(view.getByText(zh['buffer.text.value'].replace('{count}', '45000'))).toBeTruthy()
    act(() => {
      fireEvent.click(view.getByRole('button', { name: zh['save'] }))
    })
    const stored = readScreenSettings()
    expect(stored.bufferFrames).toBe(20)
    expect(stored.bufferBytes).toBe(6 * 1024 * 1024)
    expect(stored.bufferTextChars).toBe(45000)
  })

  it('starts the buffer sliders at the shipped limits', () => {
    const view = renderSection()
    expect((view.getByRole('slider', { name: zh['buffer.frames'] }) as HTMLInputElement).value)
      .toBe(String(DEFAULT_SCREEN_SETTINGS.bufferFrames))
    expect((view.getByRole('slider', { name: zh['buffer.size'] }) as HTMLInputElement).value)
      .toBe(String(DEFAULT_SCREEN_SETTINGS.bufferBytes))
    expect((view.getByRole('slider', { name: zh['buffer.text'] }) as HTMLInputElement).value)
      .toBe(String(DEFAULT_SCREEN_SETTINGS.bufferTextChars))
  })
})
