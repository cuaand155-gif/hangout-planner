const toast = document.getElementById("toast");
const showToast = (message) => {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
};

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: "smooth" }));
});

const privacyDialog = document.getElementById("privacyDialog");
const calendarDialog = document.getElementById("calendarDialog");
document.getElementById("privacyButton").addEventListener("click", () => privacyDialog.showModal());
document.getElementById("calendarButton").addEventListener("click", () => calendarDialog.showModal());
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

document.querySelectorAll(".privacy-option").forEach((option) => {
  option.addEventListener("click", () => {
    document.querySelectorAll(".privacy-option").forEach((item) => item.classList.remove("active"));
    option.classList.add("active");
    option.querySelector("input").checked = true;
  });
});
document.getElementById("savePrivacy").addEventListener("click", () => {
  const detailed = document.querySelector('input[name="privacy"]:checked').value === "details";
  document.getElementById("privacyStatus").textContent = detailed ? "Event details shared" : "Busy / free only";
  privacyDialog.close();
  showToast(detailed ? "Your event details are now visible to the group." : "Privacy setting saved: busy / free only.");
});

document.getElementById("inviteButton").addEventListener("click", () => showToast("Invite link copied to your clipboard."));
document.getElementById("shareButton").addEventListener("click", () => showToast("Availability view link copied."));
document.getElementById("planButton").addEventListener("click", () => {
  document.getElementById("ideas").scrollIntoView({ behavior: "smooth" });
  showToast("Great choice — pick an activity below.");
});
document.getElementById("addPerson").addEventListener("click", () => showToast("Invite link copied — send it to your friend."));
document.getElementById("managePeople").addEventListener("click", () => showToast("Everyone in the Weekend crew is listed here."));
document.getElementById("addIdea").addEventListener("click", () => showToast("Idea added — write a title and a little note."));
document.querySelectorAll(".heart").forEach((heart) => heart.addEventListener("click", () => {
  heart.textContent = heart.textContent === "♥" ? "♡" : "♥";
  showToast(heart.textContent === "♥" ? "Added to your group’s ideas." : "Removed from your ideas.");
}));
document.querySelectorAll(".connect-button").forEach((button) => button.addEventListener("click", () => {
  button.textContent = "Added";
  button.classList.add("connected");
  showToast("Calendar integration saved (demo).");
}));
document.querySelector(".mobile-menu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => document.querySelector(".sidebar").classList.remove("open")));
document.getElementById("settingsButton").addEventListener("click", () => showToast("Settings are coming next."));
document.querySelectorAll(".slot").forEach((slot) => slot.addEventListener("click", () => {
  document.querySelectorAll(".slot.selected").forEach((selected) => selected.classList.remove("selected"));
  slot.classList.add("selected");
  showToast(slot.classList.contains("overlap") ? "Everyone is free in this window." : "Not everyone is available here.");
}));
