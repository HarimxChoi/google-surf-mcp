// Generational lifecycle: acquire(mode) returns a lease; requestRebuild() retires the
// current gen. Existing leases keep their value and the gen closes on last release.

export interface ResourceFactory<T, M> {
  build(mode: M): Promise<T>;
  close(value: T): Promise<void>;
}

export interface ResourceLease<T> {
  readonly value: T;
  release(): void;
}

interface Gen<T, M> {
  promise: Promise<T>;
  mode: M;
  active: number;
  stale: boolean;
}

export class LeasedResource<T, M> {
  private current: Gen<T, M> | null = null;
  private closed = false;
  private readonly factory: ResourceFactory<T, M>;

  constructor(factory: ResourceFactory<T, M>) {
    this.factory = factory;
  }

  async acquire(mode: M): Promise<ResourceLease<T>> {
    if (this.closed) throw new Error('LeasedResource: closed');

    let gen = this.current;
    if (!gen || gen.stale || gen.mode !== mode) {
      if (gen) this.retire(gen);
      gen = this.startBuild(mode);
    }
    gen.active++;
    try {
      const value = await gen.promise;
      return { value, release: () => this.release(gen!, value) };
    } catch (e) {
      gen.active--;
      if (this.current === gen) this.current = null;
      throw e;
    }
  }

  requestRebuild(): void {
    if (this.current && !this.current.stale) this.retire(this.current);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const gen = this.current;
    if (!gen) return;
    this.current = null;
    await gen.promise
      .then((v) => this.factory.close(v).catch(() => {}))
      .catch(() => {});
  }

  get activeCount(): number { return this.current?.active ?? 0; }

  private startBuild(mode: M): Gen<T, M> {
    const gen: Gen<T, M> = { promise: this.factory.build(mode), mode, active: 0, stale: false };
    this.current = gen;
    return gen;
  }

  private retire(gen: Gen<T, M>): void {
    gen.stale = true;
    if (this.current === gen) this.current = null;
    if (gen.active === 0) {
      gen.promise.then((v) => this.factory.close(v).catch(() => {})).catch(() => {});
    }
  }

  private release(gen: Gen<T, M>, value: T): void {
    gen.active--;
    if (gen.active === 0 && gen.stale) {
      this.factory.close(value).catch(() => {});
    }
  }
}
