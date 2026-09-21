// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import {
  IMPROVE_ANNOUNCE_STORAGE_KEY,
  IMPROVE_READ_ALOUD_STORAGE_KEY,
  readImproveAnnounce,
  readImproveReadAloud,
  writeImproveAnnounce,
  writeImproveReadAloud,
} from '../src/improve-announce.ts'

beforeEach(() => { localStorage.clear() })

describe('improve-text voice announce toggle', () => {
  it('is off when nothing is stored', () => {
    expect(readImproveAnnounce()).toBe(false)
  })

  it('round-trips on and off', () => {
    writeImproveAnnounce(true)
    expect(readImproveAnnounce()).toBe(true)
    expect(localStorage.getItem(IMPROVE_ANNOUNCE_STORAGE_KEY)).toBe('true')
    writeImproveAnnounce(false)
    expect(readImproveAnnounce()).toBe(false)
  })

  it('treats a corrupt value as off', () => {
    localStorage.setItem(IMPROVE_ANNOUNCE_STORAGE_KEY, '???')
    expect(readImproveAnnounce()).toBe(false)
  })
})

describe('improve-text read-aloud toggle', () => {
  it('is off when nothing is stored', () => {
    expect(readImproveReadAloud()).toBe(false)
  })

  it('round-trips on and off', () => {
    writeImproveReadAloud(true)
    expect(readImproveReadAloud()).toBe(true)
    expect(localStorage.getItem(IMPROVE_READ_ALOUD_STORAGE_KEY)).toBe('true')
    writeImproveReadAloud(false)
    expect(readImproveReadAloud()).toBe(false)
  })
})
