// Replace this small configuration section when wiring a real Supabase Auth client.
// Keep configured false until the provider credentials and callback flow are deployed.
const AUTH_CONFIG = {
  provider: "supabase",
  configured: true,
  supabaseUrl: "https://xgsskeblzggrhxumiwdl.supabase.co",
  supabaseAnonKey: "sb_publishable_zo4Vdwq349r56YVFls5LRw_ff1Mx9G_",
  redirectUrl: window.location.origin,
};

const supabase = AUTH_CONFIG.configured && window.supabase
  ? window.supabase.createClient(AUTH_CONFIG.supabaseUrl, AUTH_CONFIG.supabaseAnonKey)
  : null;
const toast = document.getElementById("toast");
let workspaceState = null;
let currentUser = null;

const sampleState = {
  privacy: "busy",
  members: [
    { name: "Jamie Miller", initials: "JM", status: "All set", updated: "12m ago" },
    { name: "Taylor Kim", initials: "TK", status: "All set", updated: "1h ago" },
    { name: "Riley Lee", initials: "RL", status: "Needs update", updated: "yesterday" },
  ],
  ideas: [
    { title: "Slow morning brunch", description: "Good coffee, no rush, extra syrup.", votes: 4 },
    { title: "Picnic in the park", description: "Fresh air and a blanket in the sun.", votes: 2 },
    { title: "Games night", description: "Bring your best strategy and snacks.", votes: 3 },
  ],
};

const showToast = (message) => {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
};

async function loadWorkspace() {
  const localState = window.localStorage.getItem("gatherly-workspace");
  if (localState) {
    try {
      workspaceState = JSON.parse(localState);
      applyWorkspaceState();
    } catch {
      window.localStorage.removeItem("gatherly-workspace");
    }
  }
  try {
    const response = await fetch("/api/workspace?slug=weekend-crew");
    if (!response.ok) throw new Error("Workspace unavailable");
    workspaceState = await response.json();
    applyWorkspaceState();
  } catch {
    workspaceState = workspaceState || structuredClone(sampleState);
    applyWorkspaceState();
    showToast("Demo mode: connect the backend to sync this workspace.");
  }
}

async function saveWorkspace() {
  try {
    const response = await fetch("/api/workspace?slug=weekend-crew", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspaceState),
    });
    if (!response.ok) throw new Error("Save failed");
    workspaceState = await response.json();
    return true;
  } catch {
    window.localStorage.setItem("gatherly-workspace", JSON.stringify(workspaceState));
    showToast("Saved on this device; connect the backend to sync with friends.");
    return false;
  }
}

function applyWorkspaceState() {
  document.querySelectorAll(".person-card:not(.add-person)").forEach((card, index) => {
    const member = workspaceState.members?.[index];
    if (!member) return;
    const text = card.querySelectorAll("strong, small, .person-status");
    text[0].textContent = member.name;
    text[1].textContent = `Updated ${member.updated}`;
    text[2].textContent = member.status === "All set" ? "✓ All set" : member.status;
  });
  document.querySelectorAll(".idea-card").forEach((card, index) => {
    const idea = workspaceState.ideas?.[index];
    if (!idea) return;
    card.querySelector("h3").textContent = idea.title;
    card.querySelector(".idea-content p").textContent = idea.description;
    card.querySelector(".idea-meta span:last-child").textContent = `♡ ${idea.votes} votes`;
  });
  document.getElementById("privacyStatus").textContent =
    workspaceState.privacy === "details" ? "Event details shared" : "Busy / free only";
}

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: "smooth" }));
});

const privacyDialog = document.getElementById("privacyDialog");
const calendarDialog = document.getElementById("calendarDialog");
const accountDialog = document.getElementById("accountDialog");
const profileDialog = document.getElementById("profileDialog");
const tentativePlanDialog = document.getElementById("tentativePlanDialog");
const peopleDialog = document.getElementById("peopleDialog");
document.getElementById("privacyButton").addEventListener("click", () => privacyDialog.showModal());
document.getElementById("calendarButton").addEventListener("click", () => calendarDialog.showModal());
document.querySelectorAll("#accountButton, #topAccountButton").forEach((button) => button.addEventListener("click", () => profileDialog.showModal()));
document.querySelectorAll("#tentativePlanButton, #editTentativePlan").forEach((button) => button.addEventListener("click", () => tentativePlanDialog.showModal()));
document.getElementById("managePeople").addEventListener("click", () => {
  renderPeople();
  peopleDialog.showModal();
});
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

const timingLabels = { week: "Looking for a time this week", month: "Looking for a time this month", later: "Looking for a time later", range: "" };
const suggestedTimes = {
  week: ["Tue, Sep 23 · 10:00 AM", "Wed, Sep 24 · 12:00 PM", "Fri, Sep 26 · 6:00 PM"],
  month: ["Sat, Sep 27 · 11:00 AM", "Tue, Sep 30 · 6:00 PM", "Sat, Oct 4 · 12:00 PM"],
  later: ["Sat, Oct 11 · 11:00 AM", "Sun, Oct 19 · 1:00 PM", "Sat, Nov 1 · 6:00 PM"],
};
const tentativePlanForm = document.getElementById("tentativePlanForm");
const dateRangeFields = document.getElementById("dateRangeFields");
const savedTentativePlan = JSON.parse(window.localStorage.getItem("gatherly-tentative-plan") || "null");
const people = JSON.parse(window.localStorage.getItem("gatherly-people") || '{"friends":[],"groups":[]}');
const renderPeople = () => {
  const savedPeople = document.getElementById("savedPeople");
  savedPeople.innerHTML = [...people.friends.map((friend) => `<div class="saved-person"><span class="saved-person-icon">•</span><span>${friend.name}</span><small>Friend</small></div>`), ...people.groups.map((group) => `<div class="saved-person"><span class="saved-person-icon">✣</span><span>${group}</span><small>Group</small></div>`)].join("") || "<p class=\"form-hint\">No additional friends or groups yet.</p>";
  const audience = document.getElementById("planAudience");
  audience.innerHTML = ["Weekend crew", ...people.friends.map((friend) => friend.name), ...people.groups].map((name) => `<option>${name}</option>`).join("");
};
document.querySelectorAll(".people-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".people-tab").forEach((item) => item.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById("friendForm").hidden = tab.dataset.peopleTab !== "friend";
  document.getElementById("groupForm").hidden = tab.dataset.peopleTab !== "group";
}));
document.getElementById("friendForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const friend = {
    name: document.getElementById("friendName").value.trim(),
    email: document.getElementById("friendEmail").value.trim(),
  };
  people.friends.push(friend);
  window.localStorage.setItem("gatherly-people", JSON.stringify(people));
  if (supabase && currentUser && friend.email) {
    supabase.from("friend_invites").insert({
      sender_id: currentUser.id,
      recipient_email: friend.email,
      note: `Join my Gatherly circle, ${friend.name}.`,
    }).then(({ error }) => {
      if (error) showToast("Friend saved locally; invite sync needs the database setup.");
    });
  }
  event.target.reset();
  renderPeople();
  showToast("Friend added to your circle.");
});
document.getElementById("groupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  people.groups.push(document.getElementById("groupName").value.trim());
  window.localStorage.setItem("gatherly-people", JSON.stringify(people));
  event.target.reset();
  renderPeople();
  showToast("Friend group created.");
});
const profileForm = document.getElementById("profileForm");
let savedProfile = JSON.parse(window.localStorage.getItem("gatherly-profile") || '{"name":"Alex Morgan","photo":"","shareSchedule":true}');
const applyProfile = (profile) => {
  document.getElementById("profileName").textContent = profile.name || "Alex Morgan";
  document.getElementById("profileSubtitle").textContent = profile.shareSchedule ? "Availability shared" : "Private schedule";
  document.getElementById("profileDisplayName").value = profile.name || "";
  document.getElementById("profilePhotoUrl").value = profile.photo || "";
  document.getElementById("profileShareSchedule").checked = profile.shareSchedule !== false;
  const avatars = document.querySelectorAll(".profile-card .avatar, .account-avatar");
  avatars.forEach((avatar) => {
    avatar.textContent = profile.photo ? "" : (profile.name || "AM").split(" ").map((part) => part[0]).join("").slice(0, 2);
    avatar.style.backgroundImage = profile.photo ? `url("${profile.photo}")` : "";
    avatar.style.backgroundSize = "cover";
  });
};
applyProfile(savedProfile);
profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const profile = {
    name: document.getElementById("profileDisplayName").value.trim(),
    photo: document.getElementById("profilePhotoUrl").value.trim(),
    shareSchedule: document.getElementById("profileShareSchedule").checked,
  };
  window.localStorage.setItem("gatherly-profile", JSON.stringify(profile));
  savedProfile = profile;
  if (supabase && currentUser) {
    supabase.from("profiles").upsert({
      id: currentUser.id,
      display_name: profile.name,
      photo_url: profile.photo || null,
      share_schedule: profile.shareSchedule,
      updated_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) showToast("Profile saved locally; database sync needs the schema setup.");
    });
  }
  applyProfile(profile);
  profileDialog.close();
  showToast("Profile saved. Friends will see your updated availability setting.");
});
document.getElementById("googleCalendarButton").addEventListener("click", async () => {
  if (!supabase) {
    showToast("Connect the backend to sync Google Calendar availability.");
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/?calendar=connected`,
      queryParams: {
        access_type: "offline",
        prompt: "consent",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
      },
    },
  });
  if (error) showToast("Google Calendar connection could not start.");
});
document.getElementById("appleCalendarButton").addEventListener("click", () => showToast("Paste an iCloud read-only link in the next step."));
document.getElementById("shareScheduleToggle").addEventListener("change", (event) => {
  const profile = { ...savedProfile, shareSchedule: event.target.checked };
  savedProfile = profile;
  window.localStorage.setItem("gatherly-profile", JSON.stringify(profile));
  if (supabase && currentUser) {
    supabase.from("profiles").update({
      share_schedule: profile.shareSchedule,
      updated_at: new Date().toISOString(),
    }).eq("id", currentUser.id);
  }
  applyProfile(profile);
  showToast(event.target.checked ? "Friends can see your free/busy blocks." : "Your schedule is private.");
});
renderPeople();
const renderTentativePlan = (plan) => {
  if (!plan) return;
  document.getElementById("tentativePlanSection").hidden = false;
  document.getElementById("tentativeTitle").textContent = plan.location ? `${plan.activity} · ${plan.location}` : plan.activity;
  document.getElementById("tentativeTiming").textContent = plan.timing === "range" ? `${plan.start} – ${plan.end}` : timingLabels[plan.timing];
  const suggestions = plan.timing === "range" ? [`${plan.start} · 10:00 AM`, `${plan.end} · 12:00 PM`] : suggestedTimes[plan.timing];
  document.getElementById("tentativeSuggestions").innerHTML = `<span>Suggested windows</span>${suggestions.map((suggestion) => `<button type="button">${suggestion}</button>`).join("")}`;
};
renderTentativePlan(savedTentativePlan);
document.querySelectorAll('input[name="timing"]').forEach((input) => input.addEventListener("change", () => {
  dateRangeFields.hidden = input.value !== "range";
  document.getElementById("planStart").required = input.value === "range";
  document.getElementById("planEnd").required = input.value === "range";
}));
tentativePlanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(tentativePlanForm);
  const plan = Object.fromEntries(formData.entries());
  window.localStorage.setItem("gatherly-tentative-plan", JSON.stringify(plan));
  renderTentativePlan(plan);
  tentativePlanDialog.close();
  showToast("Tentative plan saved — we’ll look for a time.");
});

const googleSignInButton = document.getElementById("googleSignInButton");
const updateAccount = (user) => {
  currentUser = user || null;
  const signedIn = Boolean(user);
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || "Google account";
  document.getElementById("accountStatus").textContent = signedIn ? "Signed in" : "Not signed in";
  document.getElementById("accountStatusDetail").textContent = signedIn ? `${displayName} connected` : "Your local planner session is active.";
  document.getElementById("profileName").textContent = signedIn ? displayName : "Alex Morgan";
  document.getElementById("profileSubtitle").textContent = signedIn ? "Google account" : "Personal space";
};

if (supabase) {
  supabase.auth.getSession().then(async ({ data }) => {
    updateAccount(data.session?.user);
    if (data.session?.user) {
      const { data: profile } = await supabase.from("profiles").select("display_name, photo_url, share_schedule").eq("id", data.session.user.id).maybeSingle();
      if (profile) {
        savedProfile = { name: profile.display_name, photo: profile.photo_url || "", shareSchedule: profile.share_schedule };
        window.localStorage.setItem("gatherly-profile", JSON.stringify(savedProfile));
        applyProfile(savedProfile);
      }
    }
  });
  supabase.auth.onAuthStateChange((_event, session) => updateAccount(session?.user));
}

googleSignInButton.addEventListener("click", async () => {
  if (!AUTH_CONFIG.configured) {
    document.getElementById("authNote").textContent = "Google sign-in is not connected yet. Add the Supabase URL and anon key, then wire the OAuth callback described in DEPLOY.md.";
    showToast("Google sign-in needs provider credentials first.");
    return;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: AUTH_CONFIG.redirectUrl },
  });
  if (error) {
    document.getElementById("authNote").textContent = `Google sign-in could not start: ${error.message}`;
    showToast("Google sign-in could not start.");
  }
});

document.querySelectorAll(".privacy-option").forEach((option) => {
  option.addEventListener("click", () => {
    document.querySelectorAll(".privacy-option").forEach((item) => item.classList.remove("active"));
    option.classList.add("active");
    option.querySelector("input").checked = true;
  });
});
document.getElementById("savePrivacy").addEventListener("click", () => {
  const detailed = document.querySelector('input[name="privacy"]:checked').value === "details";
  workspaceState.privacy = detailed ? "details" : "busy";
  document.getElementById("privacyStatus").textContent = detailed ? "Event details shared" : "Busy / free only";
  privacyDialog.close();
  saveWorkspace().then(() => showToast(detailed ? "Your event details are now visible to the group." : "Privacy setting saved: busy / free only."));
});

document.getElementById("inviteButton").addEventListener("click", () => showToast("Invite link copied to your clipboard."));
document.getElementById("shareButton").addEventListener("click", () => showToast("Availability view link copied."));
document.getElementById("planButton").addEventListener("click", () => {
  document.getElementById("ideas").scrollIntoView({ behavior: "smooth" });
  showToast("Great choice — pick an activity below.");
});
document.getElementById("addPerson").addEventListener("click", () => showToast("Invite link copied — send it to your friend."));
document.getElementById("addIdea").addEventListener("click", () => showToast("Idea added — write a title and a little note."));
document.querySelectorAll(".heart").forEach((heart) => heart.addEventListener("click", () => {
  heart.textContent = heart.textContent === "♥" ? "♡" : "♥";
  const ideaCard = heart.closest(".idea-card");
  const ideaIndex = [...document.querySelectorAll(".idea-card")].indexOf(ideaCard);
  if (workspaceState?.ideas?.[ideaIndex]) {
    workspaceState.ideas[ideaIndex].votes = Math.max(0, workspaceState.ideas[ideaIndex].votes + (heart.textContent === "♥" ? 1 : -1));
    ideaCard.querySelector(".idea-meta span:last-child").textContent = `♡ ${workspaceState.ideas[ideaIndex].votes} votes`;
    saveWorkspace();
  }
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

loadWorkspace();
