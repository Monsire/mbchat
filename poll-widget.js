// Shared live-poll renderer used by the admin panel, /chat and /obschat.
// PollWidget.render(container, poll) builds the card once per poll/mode and
// then only mutates values, so CSS transitions animate bars and pie slices.
window.PollWidget = (() => {
  // Editorial monochrome: bars all share one white fill (the leader inverts),
  // the pie uses a grayscale ramp so slices stay distinguishable.
  const BAR_FILL = "#eeeeee";
  const PIE_COLORS = ["#eeeeee", "#bdbdbd", "#949494", "#6e6e6e", "#4f4f4f", "#383838"];
  // r=25 with a 50-wide stroke fills the circle solid (no donut hole).
  const PIE_RADIUS = 25;
  const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;

  function esc(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatRemaining(endsAt) {
    const remaining = Math.max(0, Math.ceil((Number(endsAt) - Date.now()) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function pieKeyStyle(index) {
    const color = PIE_COLORS[index % PIE_COLORS.length];
    const text = index % PIE_COLORS.length < 3 ? "#0d0d0d" : "#eeeeee";
    return `background:${color};color:${text};border-color:transparent`;
  }

  function buildBars(poll) {
    return `
      <div class="poll-options">
        ${poll.options.map((option, index) => `
          <div class="poll-option" data-option="${index}">
            <div class="poll-option-fill" data-fill="${index}" style="background:${BAR_FILL}"></div>
            <div class="poll-option-content">
              <span class="poll-option-key">${index + 1}</span>
              <span class="poll-option-label">${esc(option.label)}</span>
              <span class="poll-option-pct" data-pct="${index}">0%</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function buildPie(poll) {
    return `
      <div class="poll-pie-wrap">
        <svg class="poll-pie" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="poll-pie-track" cx="50" cy="50" r="${PIE_RADIUS}" />
          ${poll.options.map((_, index) => `
            <circle
              class="poll-pie-seg"
              data-seg="${index}"
              cx="50" cy="50" r="${PIE_RADIUS}"
              stroke="${PIE_COLORS[index % PIE_COLORS.length]}"
              stroke-dasharray="0 ${PIE_CIRCUMFERENCE}"
            />
          `).join("")}
        </svg>
        <div class="poll-legend">
          ${poll.options.map((option, index) => `
            <div class="poll-legend-row" data-option="${index}">
              <span class="poll-option-key" style="${pieKeyStyle(index)}">${index + 1}</span>
              <span class="poll-option-label">${esc(option.label)}</span>
              <span class="poll-option-pct" data-pct="${index}">0%</span>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function build(container, poll) {
    container.classList.add("poll-card");
    container.innerHTML = `
      <div class="poll-head">
        <span class="poll-question">${esc(poll.question || "Poll")}</span>
        <span class="poll-timer" data-poll-timer></span>
      </div>
      <div class="poll-time-track" data-time-track>
        <div class="poll-time-fill" data-time-fill></div>
      </div>
      ${poll.displayMode === "pie" ? buildPie(poll) : buildBars(poll)}
      <div class="poll-foot">
        <span class="poll-total" data-poll-total>0 votes</span>
        <span class="poll-hint">type <strong>1&ndash;${poll.options.length}</strong> in chat to vote</span>
      </div>
    `;
  }

  function updateValues(container, poll) {
    const total = Number(poll.totalVotes) ||
      poll.options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0);
    const maxVotes = Math.max(...poll.options.map((option) => Number(option.votes) || 0));

    poll.options.forEach((option, index) => {
      const votes = Number(option.votes) || 0;
      const fraction = total ? votes / total : 0;

      const pct = container.querySelector(`[data-pct="${index}"]`);
      if (pct) pct.textContent = `${Math.round(fraction * 100)}%${votes ? ` (${votes})` : ""}`;

      const fill = container.querySelector(`[data-fill="${index}"]`);
      if (fill) fill.style.width = `${fraction * 100}%`;

      const row = container.querySelector(`[data-option="${index}"]`);
      if (row) {
        const isLeading = total > 0 && votes === maxVotes;
        row.classList.toggle("leading", isLeading && poll.status === "active");
        row.classList.toggle("winner", isLeading && poll.status === "ended");
      }
    });

    let offset = 0;
    poll.options.forEach((option, index) => {
      const seg = container.querySelector(`[data-seg="${index}"]`);
      if (!seg) return;
      const fraction = total ? (Number(option.votes) || 0) / total : 0;
      seg.setAttribute("stroke-dasharray", `${fraction * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`);
      seg.setAttribute("stroke-dashoffset", String(-offset * PIE_CIRCUMFERENCE));
      offset += fraction;
    });

    const totalLabel = container.querySelector("[data-poll-total]");
    if (totalLabel) totalLabel.textContent = `${total} vote${total === 1 ? "" : "s"}`;

    container.classList.toggle("ended", poll.status === "ended");
    syncTimer(container, poll);
  }

  function syncTimer(container, poll) {
    const timer = container.querySelector("[data-poll-timer]");
    const timeTrack = container.querySelector("[data-time-track]");
    const timeFill = container.querySelector("[data-time-fill]");
    if (!timer) return;

    const tick = () => {
      timer.textContent = formatRemaining(poll.endsAt);
      if (timeFill) {
        const totalMs = Math.max(1, Number(poll.endsAt) - Number(poll.startedAt));
        const fraction = Math.max(0, Math.min(1, (Number(poll.endsAt) - Date.now()) / totalMs));
        timeFill.style.width = `${fraction * 100}%`;
      }
    };

    if (poll.status !== "active") {
      clearInterval(container._pollTimerId);
      container._pollTimerId = null;
      timer.textContent = "Final results";
      if (timeTrack) timeTrack.hidden = true;
      return;
    }

    if (timeTrack) timeTrack.hidden = false;
    tick();
    if (container._pollTimerId) return;
    container._pollTimerId = setInterval(() => {
      if (!container.isConnected) {
        clearInterval(container._pollTimerId);
        container._pollTimerId = null;
        return;
      }
      tick();
    }, 500);
  }

  function render(container, poll) {
    if (!container) return;

    if (!poll) {
      clearInterval(container._pollTimerId);
      container._pollTimerId = null;
      container.dataset.pollSig = "";
      container.innerHTML = "";
      container.hidden = true;
      return;
    }

    const signature = `${poll.id}:${poll.displayMode}:${poll.options.length}`;
    if (container.dataset.pollSig !== signature) {
      clearInterval(container._pollTimerId);
      container._pollTimerId = null;
      container.dataset.pollSig = signature;
      build(container, poll);
    }

    container.hidden = false;
    updateValues(container, poll);
  }

  return { render };
})();
