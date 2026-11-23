// Script of the pages outside the app (sign-in, setup, consent, errors). Every page works without
// it; the script only adds two things: the hold on the consent buttons and the copy buttons.

document.documentElement.classList.add("js");

// A form with data-hold, such as the consent to connect an app, keeps its buttons off until the
// page has been visible and focused for a moment. A click meant for another window, or a double
// click that opens this page under the pointer (double-clickjacking), then lands on nothing.
// Without this script the noscript form decides, and the held form stays hidden by the stylesheet.
function startHold() {
  const held = [...document.querySelectorAll("form[data-hold] button")];
  if (held.length === 0) return;
  let timer;
  const hold = () => {
    clearTimeout(timer);
    for (const button of held) button.disabled = true;
  };
  const release = () => {
    hold();
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    timer = setTimeout(() => {
      for (const button of held) button.disabled = false;
    }, 800);
  };
  document.addEventListener("visibilitychange", release);
  window.addEventListener("focus", release);
  window.addEventListener("blur", hold);
  release();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startHold);
} else {
  startHold();
}

// A copy button copies the value of the field it names; without the script the button stays
// hidden and the field is selectable.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  const field = button && document.getElementById(button.dataset.copy);
  if (!field) return;
  field.select();
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = button.dataset.copied;
  } catch {
    // The field stays selected for a manual copy.
  }
});
