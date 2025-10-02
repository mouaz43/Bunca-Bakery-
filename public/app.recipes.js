/* Bunca "Bakeflow" mini-app for Recipes & Rohwaren ONLY
   Pages: /rezepte-list.html, /rezept.html, /rohware.html
   - Works with existing server guards and cookies (no extra login logic)
   - CRUD for Ingredients (/api/ingredients)
   - CRUD for Recipes (/api/recipes) + Lines (/api/recipes/:id/lines)
   - Read-only until you click "Bearbeiten" (client-side toggle)
*/

(() => {
  const allowed = /\/(rezepte-list\.html|rezept\.html|rohware\.html)$/i;
  if (!allowed.test(location.pathname)) return; // run ONLY on these pages

  /* -------------------- helpers -------------------- */
  const qs  = (s, el = document) => el.querySelector(s);
  const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));
  const cfg = (window.BAKERY_CFG || {});
  const API_BASE = (cfg.API_BASE || "") + "/api";

  // UI host scaffold (safe if already present)
  function ensureHost() {
    if (!qs("#bf-app")) {
      const app = document.createElement("div");
      app.id = "bf-app";
      app.style.margin = "18px 0";
      app.innerHTML = `
        <div id="bf-progress" style="height:2px;background:#c7a76c;transform:scaleX(0);transform-origin:left;transition:.2s"></div>
        <div class="card" style="padding:12px;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">
          <div class="hstack" style="display:flex;gap:8px;align-items:center">
            <strong id="bf-title">Rezepte</strong>
            <span id="bf-role" class="small muted" style="font-size:.85rem"></span>
          </div>
          <div class="hstack" style="display:flex;gap:8px;align-items:center">
            <button id="bf-mode" class="btn small">Bearbeiten</button>
          </div>
        </div>
        <div id="bf-toolbar" class="hstack" style="display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap"></div>
        <div id="bf-view"></div>
        <div id="bf-toasts" style="position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;z-index:9999"></div>
        <div id="bf-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.25);display:none;z-index:9990"></div>
        <div id="bf-modal-host"></div>
      `;
      const main = qs("main") || document.body;
      main.appendChild(app);
    }
  }

  function setTitle(s) { const el = qs("#bf-title"); if (el) el.textContent = s; }
  function setRole(readOnly) { const el = qs("#bf-role"); if (el) el.textContent = readOnly ? "Nur Lesen" : "Bearbeiten aktiv"; }
  function setProgress(on) { const p = qs("#bf-progress"); if (p) p.style.transform = on ? "scaleX(1)" : "scaleX(0)"; }
  function toast(msg, type="ok") {
    const host = qs("#bf-toasts");
    if (!host) return alert(msg);
    const n = document.createElement("div");
    n.style.cssText = "background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.08);";
    n.textContent = msg;
    if (type === "err") n.style.borderColor = "#ef4444";
    host.appendChild(n);
    setTimeout(() => { n.style.opacity = "0"; n.style.transition = ".25s"; setTimeout(() => n.remove(), 250); }, 3000);
  }

  function modal(title, content, actions=[{label:"Schließen"}]) {
    const backdrop = qs("#bf-backdrop");
    const host = qs("#bf-modal-host");
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:9991";
    wrap.innerHTML = `
      <div class="card" style="width:min(720px,94vw);max-height:90vh;overflow:auto;padding:0">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #f0f0f0">
          <strong>${title}</strong>
          <button class="btn small" data-x>×</button>
        </div>
        <div style="padding:12px" data-bd></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;padding:12px;border-top:1px solid #f0f0f0" data-ft></div>
      </div>
    `;
    qs("[data-bd]", wrap).appendChild(content);
    const ft = qs("[data-ft]", wrap);
    actions.forEach(a => {
      const b = document.createElement("button");
      b.className = "btn small" + (a.class ? " " + a.class : "");
      b.textContent = a.label;
      b.onclick = async () => {
        try { if (a.onClick) await a.onClick(); close(); }
        catch (e) { toast(e.message || "Fehler", "err"); }
      };
      ft.appendChild(b);
    });
    function close() { backdrop.style.display = "none"; wrap.remove(); }
    qs("[data-x]", wrap).onclick = close;
    backdrop.onclick = close;
    backdrop.style.display = "block";
    host.appendChild(wrap);
    return { close };
  }

  /* -------------------- state & API -------------------- */
  const state = {
    edit: false,                // client-side read-only toggle
    ingredients: [],            // from /api/ingredients
    recipes: [],                // list from /api/recipes
    recipeDetail: null          // detail for editor/view
  };

  async function apiReq(path, opts = {}) {
    const url = API_BASE + path;
    setProgress(true);
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...opts
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || res.statusText || "Fehler");
      }
      return json;
    } finally { setProgress(false); }
  }

  // Ingredients
  async function loadIngredients() {
    const j = await apiReq("/ingredients");
    state.ingredients = j.items || [];
  }
  async function createIngredient(body) {
    const j = await apiReq("/ingredients", { method: "POST", body: JSON.stringify(body) });
    return j.item;
  }
  async function updateIngredient(id, body) {
    await apiReq(`/ingredients/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  async function deleteIngredient(id) {
    await apiReq(`/ingredients/${id}`, { method: "DELETE" });
  }

  // Recipes
  async function loadRecipes() {
    const j = await apiReq("/recipes");
    state.recipes = j.items || [];
  }
  async function loadRecipeDetail(id) {
    const j = await apiReq(`/recipes/${id}`);
    state.recipeDetail = j.recipe || null;
  }
  async function createRecipe(body) {
    const j = await apiReq("/recipes", { method: "POST", body: JSON.stringify(body) });
    return j.item;
  }
  async function updateRecipeMeta(id, body) {
    await apiReq(`/recipes/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  async function saveRecipeLines(id, lines) {
    await apiReq(`/recipes/${id}/lines`, { method: "PUT", body: JSON.stringify({ lines }) });
  }
  async function deleteRecipe(id) {
    await apiReq(`/recipes/${id}`, { method: "DELETE" });
  }

  /* -------------------- views -------------------- */
  function renderToolbar(kind) {
    const tb = qs("#bf-toolbar");
    tb.innerHTML = "";
    const left = document.createElement("div");
    left.style.cssText = "display:flex;gap:8px;align-items:center;flex:1";
    const right = document.createElement("div");
    right.style.cssText = "display:flex;gap:8px;align-items:center";

    const search = document.createElement("input");
    search.className = "input";
    search.placeholder = kind === "ingredients" ? "Suche Rohwaren…" : "Suche Rezepte…";
    search.style.minWidth = "220px";
    left.appendChild(search);

    if (kind === "ingredients" && state.edit) {
      const btnNew = document.createElement("button");
      btnNew.className = "btn";
      btnNew.textContent = "Neue Rohware";
      btnNew.onclick = () => openIngredientModal();
      right.appendChild(btnNew);
    }
    if (kind === "recipes" && state.edit) {
      const btnNew = document.createElement("button");
      btnNew.className = "btn";
      btnNew.textContent = "Neues Rezept";
      btnNew.onclick = () => openRecipeModal();
      right.appendChild(btnNew);
    }

    tb.appendChild(left);
    tb.appendChild(right);
    return { search };
  }

  // ---------- Ingredients page ----------
  function renderIngredients() {
    setTitle("Rohwaren");
    const { search } = renderToolbar("ingredients");
    const view = qs("#bf-view");
    view.innerHTML = "";

    const card = document.createElement("div");
    card.className = "card";
    card.style.padding = "0";
    card.innerHTML = `
      <table class="table">
        <thead><tr>
          <th style="width:40%">Name</th>
          <th>Einheit</th>
          <th>Aktiv</th>
          <th style="width:160px">Aktionen</th>
        </tr></thead>
        <tbody id="ing-rows"></tbody>
      </table>
    `;
    view.appendChild(card);
    const tbody = qs("#ing-rows", card);

    function draw() {
      const q = (search.value || "").toLowerCase();
      tbody.innerHTML = "";
      let data = state.ingredients.slice();
      if (q) data = data.filter(i => (i.name || "").toLowerCase().includes(q));
      if (!data.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" class="small">Keine Einträge</td>`;
        tbody.appendChild(tr);
        return;
      }
      data.forEach(it => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(it.name)}</td>
          <td>${escapeHtml(it.unit || "")}</td>
          <td>${it.active ? "Ja" : "Nein"}</td>
          <td class="td-actions">
            ${state.edit ? `
              <button class="btn small" data-act="edit">Bearbeiten</button>
              <button class="btn small" data-act="del">Löschen</button>
            ` : `<span class="small muted">–</span>`}
          </td>
        `;
        tbody.appendChild(tr);
        if (state.edit) {
          qs('[data-act="edit"]', tr).onclick = () => openIngredientModal(it);
          qs('[data-act="del"]', tr).onclick  = () =>
            confirmBox("Rohware löschen?", async () => {
              await deleteIngredient(it.id);
              await loadIngredients();
              draw();
              toast("Gelöscht");
            });
        }
      });
    }
    search.oninput = draw;
    draw();
  }

  function openIngredientModal(item) {
    const node = document.createElement("div");
    node.innerHTML = `
      <div class="vstack" style="display:grid;grid-template-columns:1fr 160px 120px;gap:10px">
        <div class="vstack"><label class="label">Name</label><input id="nm" class="input" value="${escAttr(item?.name || "")}"></div>
        <div class="vstack"><label class="label">Einheit</label><input id="un" class="input" value="${escAttr(item?.unit || "")}"></div>
        <div class="vstack"><label class="label">Aktiv</label><select id="ac" class="select"><option value="1" ${item?.active!==false?"selected":""}>Ja</option><option value="0" ${item?.active===false?"selected":""}>Nein</option></select></div>
      </div>
    `;
    modal(item ? "Rohware bearbeiten" : "Neue Rohware", node, [
      { label: "Abbrechen", class: "outline" },
      {
        label: "Speichern",
        class: "primary",
        onClick: async () => {
          const body = {
            name: qs("#nm", node).value.trim(),
            unit: qs("#un", node).value.trim(),
            active: qs("#ac", node).value === "1"
          };
          if (!body.name) throw new Error("Name erforderlich");
          if (item) await updateIngredient(item.id, body);
          else await createIngredient(body);
          await loadIngredients();
          renderIngredients();
          toast("Gespeichert");
        }
      }
    ]);
  }

  // ---------- Recipes page ----------
  function renderRecipes() {
    setTitle("Rezepte");
    const { search } = renderToolbar("recipes");
    const view = qs("#bf-view");
    view.innerHTML = "";

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px";
    view.appendChild(grid);

    function draw() {
      const q = (search.value || "").toLowerCase();
      grid.innerHTML = "";
      let data = state.recipes.slice();
      if (q) data = data.filter(r => (r.name || "").toLowerCase().includes(q));
      if (!data.length) {
        const empty = document.createElement("div");
        empty.className = "card";
        empty.style.padding = "12px";
        empty.textContent = "Keine Rezepte";
        grid.appendChild(empty);
        return;
      }
      data.forEach(r => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.padding = "12px";
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="small muted">${r.ingredients_count || 0} Zutaten</span>
          </div>
          <div class="hstack" style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px">
            <button class="btn small" data-act="view">Details</button>
            ${state.edit ? `<button class="btn small" data-act="edit">Bearbeiten</button>
            <button class="btn small" data-act="del">Löschen</button>` : ``}
          </div>
        `;
        grid.appendChild(card);
        qs('[data-act="view"]', card).onclick = async () => {
          await loadRecipeDetail(r.id);
          viewRecipeModal(state.recipeDetail);
        };
        if (state.edit) {
          qs('[data-act="edit"]', card).onclick = async () => {
            await loadRecipeDetail(r.id);
            openRecipeModal(state.recipeDetail);
          };
          qs('[data-act="del"]', card).onclick = () =>
            confirmBox("Rezept löschen?", async () => {
              await deleteRecipe(r.id);
              await loadRecipes();
              draw();
              toast("Gelöscht");
            });
        }
      });
    }

    draw();
  }

  function viewRecipeModal(rec) {
    const node = document.createElement("div");
    const rows = (rec?.lines || []).map(l =>
      `<tr><td>${escapeHtml(l.name)}</td><td>${Number(l.qty)}</td><td>${escapeHtml(l.unit || "")}</td></tr>`
    ).join("") || `<tr><td colspan="3" class="small">Keine Zutaten</td></tr>`;
    node.innerHTML = `
      <div class="vstack" style="display:flex;gap:8px">
        <div class="hstack" style="display:flex;justify-content:space-between">
          <strong>${escapeHtml(rec?.name || "")}</strong>
          <span class="small muted">${(rec?.unit || "").trim()}</span>
        </div>
        <div class="card" style="padding:0">
          <table class="table">
            <thead><tr><th>Zutat</th><th>Menge</th><th>Einheit</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
    modal("Rezept", node, [{ label: "Schließen", class: "outline" }]);
  }

  function openRecipeModal(rec) {
    // rec may be null for "new"
    const node = document.createElement("div");
    node.innerHTML = `
      <div class="grid" style="display:grid;grid-template-columns:1fr 240px;gap:10px;margin-bottom:8px">
        <div class="vstack"><label class="label">Name</label><input id="rx-name" class="input" value="${escAttr(rec?.name || "")}"></div>
        <div class="vstack"><label class="label">Rezept-Einheit (optional)</label><input id="rx-unit" class="input" value="${escAttr(rec?.unit || "")}" placeholder="z. B. Stück/Blech"></div>
      </div>
      <div class="vstack" style="display:flex;gap:8px">
        <div class="hstack" style="display:flex;justify-content:space-between;align-items:center">
          <div class="label">Zutaten</div>
          <button class="btn small" id="rx-add">Zutat hinzufügen</button>
        </div>
        <div id="rx-rows" class="vstack" style="display:flex;gap:8px"></div>
      </div>
    `;
    const rowsEl = qs("#rx-rows", node);

    function rowTemplate(l = {}) {
      const el = document.createElement("div");
      el.className = "card";
      el.style.padding = "8px 10px";
      el.innerHTML = `
        <div class="hstack" style="display:grid;grid-template-columns:1fr 120px 100px 40px;gap:8px;align-items:center">
          <select class="select" data-k="ingredientId">
            <option value="">– Zutat wählen –</option>
            ${state.ingredients.map(ing => `<option value="${ing.id}" ${l.ingredientId === ing.id ? "selected" : ""}>${escapeHtml(ing.name)}</option>`).join("")}
          </select>
          <input class="number" data-k="qty" type="number" step="0.001" value="${l.qty ?? ""}" placeholder="Menge">
          <input class="input" disabled value="${escapeHtml(state.ingredients.find(x => x.id === l.ingredientId)?.unit || "")}" placeholder="Einheit">
          <button class="btn small" data-x>×</button>
        </div>
      `;
      // auto-fill unit on ingredient change
      qs('[data-k="ingredientId"]', el).addEventListener("change", (e) => {
        const id = Number(e.target.value || 0);
        const unit = state.ingredients.find(x => x.id === id)?.unit || "";
        qsa("input.input", el)[0].value = unit;
      });
      qs("[data-x]", el).onclick = () => el.remove();
      return el;
    }

    (rec?.lines || []).forEach(l => rowsEl.appendChild(rowTemplate(l)));
    qs("#rx-add", node).onclick = () => rowsEl.appendChild(rowTemplate());

    modal(rec?.id ? "Rezept bearbeiten" : "Neues Rezept", node, [
      { label: "Abbrechen", class: "outline" },
      {
        label: "Speichern",
        class: "primary",
        onClick: async () => {
          const name = qs("#rx-name", node).value.trim();
          const unit = qs("#rx-unit", node).value.trim();
          if (!name) throw new Error("Name erforderlich");

          if (!rec?.id) {
            // create + then lines
            const created = await createRecipe({ name, unit, active: true });
            const lines = collectLines(rowsEl);
            if (lines.length) await saveRecipeLines(created.id, lines);
          } else {
            await updateRecipeMeta(rec.id, { name, unit, active: true });
            const lines = collectLines(rowsEl);
            await saveRecipeLines(rec.id, lines);
          }
          await loadRecipes();
          renderRecipes();
          toast("Gespeichert");
        }
      }
    ]);

    function collectLines(root) {
      return qsa("> .card", root).map(card => {
        const iid = Number(qs('[data-k="ingredientId"]', card).value || 0);
        const qty = Number(qs('[data-k="qty"]', card).value || 0);
        if (!iid || !(qty >= 0)) return null;
        return { ingredientId: iid, qty };
      }).filter(Boolean);
    }
  }

  function confirmBox(text, onYes) {
    const n = document.createElement("div");
    n.innerHTML = `<div>${escapeHtml(text)}</div>`;
    modal("Bestätigen", n, [
      { label: "Abbrechen", class: "outline" },
      { label: "Ja", class: "primary", onClick: onYes }
    ]);
  }

  const escapeHtml = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const escAttr   = (s) => escapeHtml(s).replace(/"/g, "&quot;");

  /* -------------------- boot by page -------------------- */
  async function boot() {
    ensureHost();

    // client-side edit toggle (no server auth change)
    const modeBtn = qs("#bf-mode");
    const syncModeUi = () => {
      state.edit = !!state.edit;
      modeBtn.textContent = state.edit ? "Nur Lesen" : "Bearbeiten";
      setRole(state.edit ? false : true);
    };
    modeBtn.onclick = () => { state.edit = !state.edit; syncModeUi(); renderForPage(); };
    syncModeUi();

    // Decide which page content to show
    if (/rohware\.html$/i.test(location.pathname)) {
      await loadIngredients();
      renderIngredients();
    } else {
      // both rezepte pages behave the same: a recipes list/editor
      await Promise.all([loadIngredients(), loadRecipes()]);
      renderRecipes();
    }
  }

  async function renderForPage() {
    if (/rohware\.html$/i.test(location.pathname)) {
      renderIngredients();
    } else {
      renderRecipes();
    }
  }

  // Start
  boot().catch((e) => toast(e.message || "Fehler", "err"));
})();
