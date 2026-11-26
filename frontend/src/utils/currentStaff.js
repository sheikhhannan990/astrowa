// Which team member is using this device. Picked once and remembered in
// this browser — not a login, just so actions are recorded under the
// right name.
const KEY = 'astrowa.staffId'

export function getCurrentStaffId() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setCurrentStaffId(id) {
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    // Private mode / blocked storage: the choice just won't be remembered.
  }
}
