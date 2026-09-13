#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOUNDFONT_DIR="${ROOT_DIR}/artifacts/film-score-studio/public/soundfonts"

restore_one() {
  local name="$1"
  local soundfont="${SOUNDFONT_DIR}/${name}"
  local part_prefix="${soundfont}.part-"
  local temp_file="${soundfont}.reassembled"

  if [[ -f "${soundfont}" ]]; then
    echo "SoundFont already exists: ${soundfont}"
    return 0
  fi

  shopt -s nullglob
  local parts=( "${part_prefix}"* )
  shopt -u nullglob

  if (( ${#parts[@]} == 0 )); then
    echo "No chunks found for ${name}; skipping."
    return 0
  fi

  IFS=$'\n' parts=( $(printf '%s\n' "${parts[@]}" | sort) )
  cat "${parts[@]}" > "${temp_file}"
  mv "${temp_file}" "${soundfont}"

  echo "Reassembled ${soundfont}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${soundfont}"
  fi
}

restore_one "fluidr3-gm.sf2"
restore_one "upright-piano-kw.sf2"