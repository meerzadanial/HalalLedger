import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomUuidGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
