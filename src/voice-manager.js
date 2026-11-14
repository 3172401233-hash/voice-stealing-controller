export const VoiceState = Object.freeze({
  PLAYING: 'playing',
  VIRTUAL: 'virtual',
  FADING: 'fading',
  STOPPED: 'stopped',
});

const DEFAULTS = {
  budget: 8,
  protectedSlots: 2,
  protectedCategories: ['dialogue', 'critical'],
  hysteresis: 5,
  distanceFalloff: 0.5,
  maxDistance: 100,
  fadeOutMs: 120,
  finishBonusWindowMs: 500,
  finishBonus: 10,
};

export class VoiceManager {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.voices = new Map();
    this.budget = this.config.budget;
    this._seq = 0;
    this._now = 0;
  }

  declare(voice) {
    if (!voice || voice.id == null) {
      throw new TypeError('declare() requires a voice with an id');
    }
    const existing = this.voices.get(voice.id);
    const record = {
      id: voice.id,
      category: voice.category ?? 'sfx',
      priority: voice.priority ?? 0,
      distance: voice.distance ?? 0,
      duration: voice.duration ?? Infinity,
      elapsed: voice.elapsed ?? 0,
      state: existing ? existing.state : VoiceState.VIRTUAL,
      fadeStartedAt: existing ? existing.fadeStartedAt : null,
      seq: existing ? existing.seq : this._seq++,
    };
    this.voices.set(voice.id, record);
    return record;
  }

  updateVoice(id, patch) {
    const voice = this.voices.get(id);
    if (!voice) return undefined;
    for (const key of ['category', 'priority', 'distance', 'duration', 'elapsed']) {
      if (patch[key] !== undefined) voice[key] = patch[key];
    }
    return voice;
  }

  remove(id) {
    const voice = this.voices.get(id);
    if (!voice) return false;
    voice.state = VoiceState.STOPPED;
    this.voices.delete(id);
    return true;
  }

  setBudget(budget) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new RangeError('budget must be a non-negative integer');
    }
    this.budget = budget;
  }

  isProtected(voice) {
    return this.config.protectedCategories.includes(voice.category);
  }

  score(voice) {
    const distance = Math.min(Math.max(voice.distance, 0), this.config.maxDistance);
    let value = voice.priority - distance * this.config.distanceFalloff;
    const remaining = voice.duration - voice.elapsed;
    if (remaining <= this.config.finishBonusWindowMs) {
      value += this.config.finishBonus;
    }
    return value;
  }

  _sortedByScore(voices) {
    return [...voices].sort((a, b) => {
      const diff = this.score(b) - this.score(a);
      if (diff !== 0) return diff;
      const aPlaying = a.state === VoiceState.PLAYING ? 0 : 1;
      const bPlaying = b.state === VoiceState.PLAYING ? 0 : 1;
      if (aPlaying !== bPlaying) return aPlaying - bPlaying;
      return a.seq - b.seq;
    });
  }

  _allocate() {
    const active = [...this.voices.values()];
    const protectedVoices = this._sortedByScore(active.filter((v) => this.isProtected(v)));
    const reserved = Math.min(this.config.protectedSlots, this.budget);

    const targets = new Map();
    const protectedPlaying = protectedVoices.slice(0, reserved);
    for (const voice of protectedPlaying) targets.set(voice.id, VoiceState.PLAYING);

    const pool = [
      ...protectedVoices.slice(reserved),
      ...active.filter((v) => !this.isProtected(v)),
    ];
    const capacity = this.budget - protectedPlaying.length;

    const incumbents = this._sortedByScore(pool.filter((v) => v.state === VoiceState.PLAYING));
    const challengers = this._sortedByScore(pool.filter((v) => v.state !== VoiceState.PLAYING));

    const granted = incumbents.slice(0, capacity);
    for (const voice of granted) targets.set(voice.id, VoiceState.PLAYING);
    for (const dropped of incumbents.slice(capacity)) targets.set(dropped.id, VoiceState.VIRTUAL);

    for (const voice of challengers) {
      if (granted.length < capacity) {
        granted.push(voice);
        targets.set(voice.id, VoiceState.PLAYING);
        continue;
      }
      let weakest = null;
      for (const incumbent of granted) {
        if (!weakest || this.score(incumbent) < this.score(weakest)) weakest = incumbent;
      }
      const margin = weakest.state === VoiceState.PLAYING ? this.config.hysteresis : 0;
      if (this.score(voice) > this.score(weakest) + margin) {
        granted.splice(granted.indexOf(weakest), 1);
        granted.push(voice);
        targets.set(weakest.id, VoiceState.VIRTUAL);
        targets.set(voice.id, VoiceState.PLAYING);
      } else {
        targets.set(voice.id, VoiceState.VIRTUAL);
      }
    }
    return targets;
  }

  update(now = this._now) {
    this._now = now;
    for (const voice of [...this.voices.values()]) {
      if (voice.state === VoiceState.FADING && now - voice.fadeStartedAt >= this.config.fadeOutMs) {
        voice.state = VoiceState.VIRTUAL;
        voice.fadeStartedAt = null;
      }
    }

    const targets = this._allocate();
    const fadePlan = [];
    const resumed = [];
    const stolen = [];

    for (const voice of this.voices.values()) {
      const target = targets.get(voice.id) ?? VoiceState.VIRTUAL;
      if (voice.state === VoiceState.FADING) {
        if (target === VoiceState.PLAYING) {
          voice.state = VoiceState.PLAYING;
          voice.fadeStartedAt = null;
          resumed.push(voice.id);
        }
        continue;
      }
      if (voice.state === VoiceState.PLAYING && target !== VoiceState.PLAYING) {
        voice.state = VoiceState.FADING;
        voice.fadeStartedAt = now;
        fadePlan.push({ id: voice.id, fadeOutMs: this.config.fadeOutMs, startAt: now });
        stolen.push(voice.id);
      } else if (voice.state !== VoiceState.PLAYING && target === VoiceState.PLAYING) {
        voice.state = VoiceState.PLAYING;
        resumed.push(voice.id);
      }
    }

    return {
      states: new Map([...this.voices.values()].map((v) => [v.id, v.state])),
      targets,
      fadePlan,
      resumed,
      stolen,
    };
  }
}
