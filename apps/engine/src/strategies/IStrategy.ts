import { Bar, TradeSignal } from "@my-platform/types";

export interface IStrategy {
    hydrate(bars: Bar[], prevLow?: number): void;
    evaluateStrategy(bar: Bar): TradeSignal;
}