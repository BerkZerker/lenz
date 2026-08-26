export interface Todo { id: number; title: string; done: boolean }

/** In-memory todo store. */
export function createStore() {
  const todos: Todo[] = [];
  let next = 1;
  return {
    list(filter?: "open" | "done"): Todo[] {
      if (filter === undefined) return todos.slice();
      if (filter === "open") return todos.filter((t) => !t.done);
      if (filter === "done") return todos.filter((t) => t.done);
      throw new Error(`invalid filter: ${filter}`);
    },
    add(title: string): Todo {
      if (title.trim() === "") throw new Error("title is required");
      const t = { id: next++, title, done: false };
      todos.push(t);
      return t;
    },
    remove(id: number): void {
      const i = todos.findIndex((t) => t.id === id);
      if (i === -1) throw new Error(`todo not found: ${id}`);
      todos.splice(i, 1);
    },
    done(id: number): Todo {
      const t = todos.find((t) => t.id === id);
      if (!t) throw new Error(`todo not found: ${id}`);
      t.done = true;
      return t;
    },
  };
}
