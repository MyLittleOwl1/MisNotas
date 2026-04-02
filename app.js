// app.js - Módulo principal

// ---------- MODELO: IndexedDB ----------
class NotesDB {
    constructor() {
        this.dbName = 'NotesFlowDB';
        this.storeName = 'notes';
        this.db = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 2);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt');
                    store.createIndex('pinned', 'pinned');
                    store.createIndex('favorite', 'favorite');
                    store.createIndex('deletedAt', 'deletedAt');
                }
            };
        });
    }

    async getAllNotes() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async saveNote(note) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(note);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async deleteNotePermanently(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async bulkSave(notes) {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        for (const note of notes) {
            store.put(note);
        }
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

}

// ---------- UTILS ----------
function generateId() {
    return Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

function createEmptyNote() {
    const now = new Date().toISOString();
    return {
        id: generateId(),
        title: "Nueva nota",
        text: "",
        datetime: now,
        createdAt: now,
        updatedAt: now,
        tags: [],
        pinned: false,
        favorite: false,
        deletedAt: null
    };
}

function normalizeImportedNote(note) {
    if (!note.id) note.id = generateId();
    if (!note.datetime) note.datetime = new Date().toISOString();
    if (!note.createdAt) note.createdAt = note.datetime;
    if (!note.updatedAt) note.updatedAt = note.datetime;
    if (!note.title) note.title = "Sin título";
    if (!note.text) note.text = "";
    if (!note.tags) note.tags = [];
    if (typeof note.pinned === 'undefined') note.pinned = false;
    if (typeof note.favorite === 'undefined') note.favorite = false;
    if (!note.deletedAt) note.deletedAt = null;
    return note;
}

// ---------- CONTROLADOR PRINCIPAL ----------
class NotesApp {
    constructor() {
        this.db = new NotesDB();
        this.allNotes = [];       // todas las notas (incluidas eliminadas)
        this.filteredSorted = []; // después de filtros y orden
        this.currentLimit = 30;   // scroll infinito
        this.step = 30;
        this.selectedNoteId = null;
        this.currentFilter = { search: '', tag: '', type: 'all', sort: 'recent' };
        this.compactView = false;
        this.debounceSave = null;
        this.isTrashMode = false;  // papelera activa
        this.deferredPrompt = null;
        this.isMobilePanel = 'list';
        this.init();
    }

    async init() {
        await this.db.open();
        await this.loadNotes();
        this.bindEvents();
        this.setupNetworkStatus();
        this.setupPwaInstallPrompt();
        this.setupMobileView();
        this.render();
        this.registerServiceWorker();
        this.setupKeyboardShortcuts();
        this.showToast("NotasFlow lista ✨", 2000);
    }

    async loadNotes() {
        const notes = await this.db.getAllNotes();
        this.allNotes = notes.length ? notes : [this.getDefaultNote()];
        if (notes.length === 0) await this.db.saveNote(this.allNotes[0]);
        this.applyFiltersAndSort();
    }

    getDefaultNote() {
        const defaultNote = createEmptyNote();
        defaultNote.title = "¡Bienvenido!";
        defaultNote.text = "Esta es tu primera nota. Puedes editarla, añadir tags #ideas, fijarla, etc.\n\nDisfruta de la experiencia local-first.";
        defaultNote.tags = ["inicio", "ejemplo"];
        return defaultNote;
    }

    applyFiltersAndSort() {
        let filtered = this.allNotes.filter(n => {
            if (this.isTrashMode) return n.deletedAt !== null;
            else return n.deletedAt === null;
        });

        // Búsqueda por texto
        if (this.currentFilter.search) {
            const term = this.currentFilter.search.toLowerCase();
            filtered = filtered.filter(n => n.title.toLowerCase().includes(term) || n.text.toLowerCase().includes(term));
        }
        // Filtro por tag
        if (this.currentFilter.tag) {
            filtered = filtered.filter(n => n.tags.some(t => t.toLowerCase().includes(this.currentFilter.tag.toLowerCase())));
        }
        // Tipo adicional
        if (!this.isTrashMode) {
            switch (this.currentFilter.type) {
                case 'pinned': filtered = filtered.filter(n => n.pinned); break;
                case 'favorites': filtered = filtered.filter(n => n.favorite); break;
                case 'recent7':
                    const weekAgo = new Date();
                    weekAgo.setDate(weekAgo.getDate() - 7);
                    filtered = filtered.filter(n => new Date(n.updatedAt) > weekAgo);
                    break;
                default: break;
            }
        }

        // Ordenamiento
        switch (this.currentFilter.sort) {
            case 'recent': filtered.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)); break;
            case 'oldest': filtered.sort((a,b) => new Date(a.updatedAt) - new Date(b.updatedAt)); break;
            case 'pinned': filtered.sort((a,b) => (b.pinned - a.pinned) || (new Date(b.updatedAt) - new Date(a.updatedAt))); break;
            case 'alpha': filtered.sort((a,b) => a.title.localeCompare(b.title)); break;
        }
        this.filteredSorted = filtered;
        this.currentLimit = this.step;
        this.renderNotesList();
        this.updateNoteCountBadge();
    }

    render() {
        this.applyFiltersAndSort();
        this.updateNoteCountBadge();

        if (this.selectedNoteId) {
            const note = this.allNotes.find(n => n.id === this.selectedNoteId);
            if (note) this.loadNoteToEditor(note);
            else this.clearEditor();
        } else {
            this.clearEditor();
        }

        this.updateMobilePanel();
    }

    renderNotesList() {
        const container = document.getElementById('notesList');
        if (!container) return;
        const limited = this.filteredSorted.slice(0, this.currentLimit);
        container.innerHTML = limited.map(note => this.renderNoteCard(note)).join('');
        // Marcar la nota seleccionada
        document.querySelectorAll('.note-card').forEach(card => {
            if (card.dataset.id === this.selectedNoteId) card.classList.add('selected');
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectNote(card.dataset.id);
            });
        });
        // Scroll loader observer
        this.setupInfiniteScroll();
    }

    renderNoteCard(note) {
        const title = note.title || "Sin título";
        const preview = note.text.substring(0, 60).replace(/\n/g, ' ');
        const date = new Date(note.updatedAt).toLocaleDateString();
        const tagsHtml = note.tags.slice(0, 2).map(t => `<span class="note-tag">${escapeHtml(t)}</span>`).join('');
        const pinnedIcon = note.pinned ? '📌 ' : '';
        const favIcon = note.favorite ? '⭐ ' : '';
        return `
            <div class="note-card ${this.compactView ? 'compact' : ''}" data-id="${note.id}">
                <div class="note-card-title">
                    <span>${pinnedIcon}${favIcon}${escapeHtml(title)}</span>
                </div>
                <div class="note-card-preview">${escapeHtml(preview)}</div>
                <div class="note-card-meta">
                    <span>${date}</span>
                    ${tagsHtml}
                </div>
            </div>
        `;
    }

    setupInfiniteScroll() {
        const listContainer = document.querySelector('.notes-list-container');
        if (!listContainer) return;
        const onScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = listContainer;
            if (scrollTop + clientHeight >= scrollHeight - 100) {
                if (this.currentLimit < this.filteredSorted.length) {
                    this.currentLimit += this.step;
                    this.renderNotesList();
                }
            }
        };
        listContainer.removeEventListener('scroll', this._scrollHandler);
        this._scrollHandler = onScroll;
        listContainer.addEventListener('scroll', this._scrollHandler);
    }

    selectNote(id) {
        this.selectedNoteId = id;
        const note = this.allNotes.find(n => n.id === id);

        if (note && note.deletedAt === null && !this.isTrashMode) {
            this.loadNoteToEditor(note);
        } else if (this.isTrashMode && note && note.deletedAt !== null) {
            this.showToast("Nota en papelera, no se puede editar. Restáurala primero.");
            this.loadNoteToEditor(note);
        } else {
            this.clearEditor();
        }

        if (window.innerWidth <= 768) {
            this.isMobilePanel = 'editor';
            this.updateMobilePanel();
        }

        this.renderNotesList();
    }

    loadNoteToEditor(note) {
        document.getElementById('noteTitle').value = note.title || '';
        document.getElementById('noteText').value = note.text || '';
        document.getElementById('noteTags').value = (note.tags || []).join(', ');
        document.getElementById('wordCounter').innerText = `${note.text.split(/\s+/).filter(w=>w.length).length} palabras · ${note.text.length} caracteres`;
        document.getElementById('noteMeta').innerHTML = `Creado: ${new Date(note.createdAt).toLocaleString()} | Actualizado: ${new Date(note.updatedAt).toLocaleString()}`;
        document.getElementById('autoSaveStatus').innerText = '✓ Cargado';
        this.updateEditorButtonsState(note);
    }

    clearEditor() {
        document.getElementById('noteTitle').value = '';
        document.getElementById('noteText').value = '';
        document.getElementById('noteTags').value = '';
        document.getElementById('wordCounter').innerText = '0 palabras · 0 caracteres';
        document.getElementById('noteMeta').innerHTML = 'Selecciona una nota';
        document.getElementById('autoSaveStatus').innerText = '';
    }

    updateEditorButtonsState(note) {
        const pinBtn = document.getElementById('pinNoteBtn');
        const favBtn = document.getElementById('favoriteNoteBtn');
        if (pinBtn) pinBtn.style.opacity = note.pinned ? '1' : '0.5';
        if (favBtn) favBtn.style.opacity = note.favorite ? '1' : '0.5';
    }

    async saveCurrentNote() {
        if (!this.selectedNoteId) return;
        const title = document.getElementById('noteTitle').value;
        const text = document.getElementById('noteText').value;
        const tagsStr = document.getElementById('noteTags').value;
        const tags = tagsStr.split(',').map(t => t.trim()).filter(t => t);
        const noteIndex = this.allNotes.findIndex(n => n.id === this.selectedNoteId);
        if (noteIndex === -1) return;
        const updatedNote = { ...this.allNotes[noteIndex] };
        updatedNote.title = title || "Sin título";
        updatedNote.text = text;
        updatedNote.tags = tags;
        updatedNote.updatedAt = new Date().toISOString();
        this.allNotes[noteIndex] = updatedNote;
        await this.db.saveNote(updatedNote);
        this.applyFiltersAndSort();
        document.getElementById('autoSaveStatus').innerText = '✓ Guardado automático';
        setTimeout(() => { if(document.getElementById('autoSaveStatus')) document.getElementById('autoSaveStatus').innerText = '✓ Todo guardado'; }, 1500);
        this.updateEditorButtonsState(updatedNote);
        this.showToast("Nota guardada");
    }

    async newNote() {
        const newNote = createEmptyNote();
        this.allNotes.unshift(newNote);
        await this.db.saveNote(newNote);
        this.selectedNoteId = newNote.id;
        this.isTrashMode = false;
        this.applyFiltersAndSort();
        this.loadNoteToEditor(newNote);
        if (window.innerWidth <= 768) {
            this.isMobilePanel = 'editor';
            this.updateMobilePanel();
        }
        this.showToast("Nueva nota creada");
    }

    async duplicateNote() {
        if (!this.selectedNoteId) return;
        const original = this.allNotes.find(n => n.id === this.selectedNoteId);
        if (!original || original.deletedAt) return;
        const copy = { ...original, id: generateId(), title: original.title + " (copia)", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        this.allNotes.push(copy);
        await this.db.saveNote(copy);
        this.selectedNoteId = copy.id;
        this.applyFiltersAndSort();
        this.loadNoteToEditor(copy);
        this.showToast("Nota duplicada");
    }

    async deleteNote() {
        if (!this.selectedNoteId) return;
        const confirmDel = await this.confirmDialog("¿Mover a papelera? (puedes restaurar después)");
        if (!confirmDel) return;
        const note = this.allNotes.find(n => n.id === this.selectedNoteId);
        if (note) {
            note.deletedAt = new Date().toISOString();
            await this.db.saveNote(note);
            this.selectedNoteId = null;
            this.clearEditor();
            this.applyFiltersAndSort();
            this.showToast("Nota movida a papelera");
        }
    }

        async deleteAllNotes() {
    const confirm = await this.confirmDialog("¿Eliminar TODAS las notas activas? Se moverán a la papelera. Puedes restaurarlas después.");
    if (!confirm) return;
    let anyChanged = false;
    for (let note of this.allNotes) {
        if (note.deletedAt === null) {
            note.deletedAt = new Date().toISOString();
            await this.db.saveNote(note);
            anyChanged = true;
        }
    }
    if (anyChanged) {
        this.selectedNoteId = null;
        this.clearEditor();
        this.applyFiltersAndSort();
        this.showToast("Todas las notas movidas a la papelera");
    } else {
        this.showToast("No hay notas activas para eliminar");
    }
}

    async restoreFromTrash(noteId) {
        const note = this.allNotes.find(n => n.id === noteId);
        if (note && note.deletedAt) {
            note.deletedAt = null;
            await this.db.saveNote(note);
            this.selectedNoteId = note.id;
            this.isTrashMode = false;
            this.applyFiltersAndSort();
            this.showToast("Nota restaurada");
        }
    }

    async togglePin() {
        if (!this.selectedNoteId) return;
        const note = this.allNotes.find(n => n.id === this.selectedNoteId);
        if (note && !note.deletedAt) {
            note.pinned = !note.pinned;
            await this.db.saveNote(note);
            this.applyFiltersAndSort();
            this.updateEditorButtonsState(note);
            this.showToast(note.pinned ? "Fijada" : "No fijada");
        }
    }

    async toggleFavorite() {
        if (!this.selectedNoteId) return;
        const note = this.allNotes.find(n => n.id === this.selectedNoteId);
        if (note && !note.deletedAt) {
            note.favorite = !note.favorite;
            await this.db.saveNote(note);
            this.applyFiltersAndSort();
            this.updateEditorButtonsState(note);
            this.showToast(note.favorite ? "Favorita" : "No favorita");
        }
    }

    emailNote() {
        if (!this.selectedNoteId) return;
        const note = this.allNotes.find(n => n.id === this.selectedNoteId);
        if (note && !note.deletedAt) {
            const subject = encodeURIComponent(note.title);
            const body = encodeURIComponent(`${note.text}\n\nTags: ${note.tags.join(', ')}`);
            window.location.href = `mailto:?subject=${subject}&body=${body}`;
            this.showToast("Abriendo cliente de correo...");
        }
    }

    exportNoteAsJson() {
        if (!this.selectedNoteId) return;
        const note = this.allNotes.find(n => n.id === this.selectedNoteId);
        const dataStr = JSON.stringify(note, null, 2);
        this.downloadJson(dataStr, `nota_${note.id}.json`);
        this.showToast("Nota exportada");
    }

    exportAllNotes() {
        const exportData = this.allNotes.filter(n => n.deletedAt === null).map(({ deletedAt, ...rest }) => rest);
        const dataStr = JSON.stringify(exportData, null, 2);
        this.downloadJson(dataStr, "notasflow_backup.json");
        this.showToast("Todas las notas exportadas");
    }

    downloadJson(content, filename) {
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    async importJson(replaceMode) {
        const fileInput = document.getElementById('importFile');
        const file = fileInput.files[0];
        if (!file) return this.showToast("Selecciona un archivo JSON");
        try {
            const text = await file.text();
            const imported = JSON.parse(text);
            if (!Array.isArray(imported)) throw new Error("El JSON debe ser un array de notas");
            const validNotes = imported.map(n => normalizeImportedNote(n));
            if (replaceMode) {
                const keepTrashed = this.allNotes.filter(n => n.deletedAt !== null);
                this.allNotes = [...keepTrashed, ...validNotes];
                await this.db.bulkSave(this.allNotes);
            } else {
                // Fusion: evitar duplicados por id
                const existingIds = new Set(this.allNotes.map(n => n.id));
                const newNotes = validNotes.filter(n => !existingIds.has(n.id));
                this.allNotes.push(...newNotes);
                await this.db.bulkSave(newNotes);
                this.showToast(`Fusionado: ${newNotes.length} nuevas notas`);
            }
            this.applyFiltersAndSort();
            document.getElementById('importModal').style.display = 'none';
            this.showToast("Importación completada");
        } catch(e) {
            this.showToast("Error en JSON: " + e.message, 3000);
        }
    }

    // UI events
    bindEvents() {
        document.getElementById('newNoteBtn').onclick = () => this.newNote();
        document.getElementById('duplicateNoteBtn').onclick = () => this.duplicateNote();
        document.getElementById('deleteNoteBtn').onclick = () => this.deleteNote();
        document.getElementById('pinNoteBtn').onclick = () => this.togglePin();
        document.getElementById('favoriteNoteBtn').onclick = () => this.toggleFavorite();
        document.getElementById('emailNoteBtn').onclick = () => this.emailNote();
        document.getElementById('exportNoteBtn').onclick = () => this.exportNoteAsJson();
        document.getElementById('exportAllBtn').onclick = () => this.exportAllNotes();
        document.getElementById('importBtn').onclick = () => document.getElementById('importModal').style.display = 'flex';
        document.getElementById('closeImportModal').onclick = () => document.getElementById('importModal').style.display = 'none';
        document.getElementById('importReplaceBtn').onclick = () => this.importJson(true);
        document.getElementById('importMergeBtn').onclick = () => this.importJson(false);
        document.getElementById('themeToggle').onclick = () => this.toggleTheme();
        document.getElementById('compactToggle').onclick = () => { this.compactView = !this.compactView; this.renderNotesList(); };
        document.getElementById('searchInput').addEventListener('input', (e) => { this.currentFilter.search = e.target.value; this.applyFiltersAndSort(); });
        document.getElementById('tagFilterInput').addEventListener('input', (e) => { this.currentFilter.tag = e.target.value; this.applyFiltersAndSort(); });
        document.getElementById('sortSelect').addEventListener('change', (e) => { this.currentFilter.sort = e.target.value; this.applyFiltersAndSort(); });
        document.getElementById('filterTypeSelect').addEventListener('change', (e) => { this.currentFilter.type = e.target.value; this.applyFiltersAndSort(); });
        document.getElementById('trashBtn').onclick = () => { this.isTrashMode = !this.isTrashMode; this.applyFiltersAndSort(); this.clearEditor(); this.showToast(this.isTrashMode ? "Modo papelera" : "Modo notas activas"); };
        document.getElementById('noteTitle').addEventListener('input', () => this.debouncedSave());
        document.getElementById('noteText').addEventListener('input', () => { this.debouncedSave(); this.updateWordCount(); });
        document.getElementById('noteTags').addEventListener('input', () => this.debouncedSave());
        document.getElementById('deleteAllBtn').onclick = () => this.deleteAllNotes();
        this.debouncedSave = this.debounce(() => this.saveCurrentNote(), 600);
    }

    updateWordCount() {
        const text = document.getElementById('noteText').value;
        const words = text.split(/\s+/).filter(w=>w.length).length;
        document.getElementById('wordCounter').innerText = `${words} palabras · ${text.length} caracteres`;
    }

    debounce(fn, delay) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
    }

    toggleTheme() {
        const container = document.querySelector('.app-container');
        const isDark = container.getAttribute('data-theme') === 'dark';
        container.setAttribute('data-theme', isDark ? 'light' : 'dark');
        localStorage.setItem('notesTheme', isDark ? 'light' : 'dark');
    }

    updateNoteCountBadge() {
        const active = this.allNotes.filter(n => n.deletedAt === null).length;
        document.getElementById('noteCountBadge').innerText = active;
    }

    confirmDialog(msg) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            document.getElementById('confirmMsg').innerText = msg;
            modal.style.display = 'flex';
            const onYes = () => { modal.style.display = 'none'; cleanup(); resolve(true); };
            const onNo = () => { modal.style.display = 'none'; cleanup(); resolve(false); };
            const cleanup = () => {
                document.getElementById('confirmYesBtn').removeEventListener('click', onYes);
                document.getElementById('confirmNoBtn').removeEventListener('click', onNo);
            };
            document.getElementById('confirmYesBtn').addEventListener('click', onYes);
            document.getElementById('confirmNoBtn').addEventListener('click', onNo);
        });
    }

    showToast(msg, duration = 2000) {
        const toast = document.getElementById('toast');
        toast.innerText = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), duration);
    }

    setupKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); this.newNote(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveCurrentNote(); }
            if (e.key === 'Escape') { document.getElementById('searchInput').value = ''; this.currentFilter.search = ''; this.applyFiltersAndSort(); }
        });
    }

    setupNetworkStatus() {
        const updateStatus = () => {
            if (navigator.onLine) {
                this.showToast('Conectado en línea ✅');
                document.body.classList.remove('offline');
            } else {
                this.showToast('Sin conexión ⚠️ (modo offline activo)');
                document.body.classList.add('offline');
            }
        };
        window.addEventListener('online', updateStatus);
        window.addEventListener('offline', updateStatus);
        updateStatus();
    }

    setupPwaInstallPrompt() {
        const installBtn = document.getElementById('installBtn');
        if (!installBtn) return;
        installBtn.style.display = 'none';

        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            this.deferredPrompt = event;
            installBtn.style.display = 'inline-flex';
            installBtn.addEventListener('click', async () => {
                if (!this.deferredPrompt) return;
                this.deferredPrompt.prompt();
                const { outcome } = await this.deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    this.showToast('Instalación iniciada ✅');
                } else {
                    this.showToast('Instalación cancelada');
                }
                this.deferredPrompt = null;
                installBtn.style.display = 'none';
            }, { once: true });
        });

        window.addEventListener('appinstalled', () => {
            this.showToast('App instalada correctamente 🎉');
            installBtn.style.display = 'none';
            this.deferredPrompt = null;
        });
    }

    setupMobileView() {
        const mobileNav = document.getElementById('mobileNav');
        const notesBtn = document.getElementById('mobileNotesViewBtn');
        const editorBtn = document.getElementById('mobileEditorViewBtn');

        notesBtn?.addEventListener('click', () => {
            this.isMobilePanel = 'list';
            this.updateMobilePanel();
        });
        editorBtn?.addEventListener('click', () => {
            this.isMobilePanel = 'editor';
            this.updateMobilePanel();
        });

        window.addEventListener('resize', () => this.updateMobilePanel());
        this.updateMobilePanel();
    }

    updateMobilePanel() {
        const mobileNav = document.getElementById('mobileNav');
        const notesSidebar = document.querySelector('.notes-sidebar');
        const editorArea = document.querySelector('.editor-area');

        if (!mobileNav || !notesSidebar || !editorArea) return;

        if (window.innerWidth > 768) {
            mobileNav.style.display = 'none';
            notesSidebar.classList.remove('hidden');
            editorArea.classList.remove('hidden');
            notesSidebar.style.display = 'flex';
            editorArea.style.display = 'block';
            return;
        }

        mobileNav.style.display = 'flex';

        if (this.isMobilePanel === 'editor') {
            notesSidebar.classList.add('hidden');
            editorArea.classList.remove('hidden');
            notesSidebar.style.display = 'none';
            editorArea.style.display = 'block';
        } else {
            notesSidebar.classList.remove('hidden');
            editorArea.classList.add('hidden');
            notesSidebar.style.display = 'flex';
            editorArea.style.display = 'none';
        }
    }

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./service-worker.js').catch(err => console.log("SW error:", err));
        }
    }
}

function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }

// Inicializar la app
document.addEventListener('DOMContentLoaded', () => {
    window.app = new NotesApp();
    const savedTheme = localStorage.getItem('notesTheme');
    if (savedTheme) document.querySelector('.app-container').setAttribute('data-theme', savedTheme);
});