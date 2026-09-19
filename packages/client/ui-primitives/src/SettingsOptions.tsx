// Settings option-row atoms: radio rows and the save footer shared by the
// settings pages. Sections own their cards and copy; rows share this chrome.

import type { ReactNode } from 'react'
import css from './SettingsOptions.module.css'

/**
 * Render one radio option row for a settings card.
 * @param props.name - native radio group name.
 * @param props.value - option value.
 * @param props.label - visible option text.
 * @param props.checked - selected state.
 * @param props.onSelect - selection callback (no event surfacing: the value is known).
 * @param props.leading - optional node between the radio and the label.
 * @returns the labeled radio row.
 */
export function SettingsRadioOption({ name, value, label, checked, onSelect, leading }: {
  name: string
  value: string
  label: string
  checked: boolean
  onSelect: () => void
  /** Optional node between the radio and the label (e.g. a color dot). */
  leading?: ReactNode | undefined
}) {
  return (
    <label className={css.option}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} />
      {leading}
      {label}
    </label>
  )
}

/**
 * Render the settings-page save footer: save button plus the transient saved
 * confirmation.
 * @param props.saveLabel - save button text.
 * @param props.saved - whether to show the confirmation.
 * @param props.savedLabel - confirmation text.
 * @param props.onSave - save callback.
 * @returns the footer row.
 */
export function SettingsSaveBar({ saveLabel, saved, savedLabel, onSave }: {
  saveLabel: string
  saved: boolean
  savedLabel: string
  onSave: () => void
}) {
  return (
    <div className={css.footer}>
      <button type="button" className={css.save} onClick={onSave}>
        {saveLabel}
      </button>
      {saved ? (
        <span className={css.status} role="status">
          {savedLabel}
        </span>
      ) : null}
    </div>
  )
}
