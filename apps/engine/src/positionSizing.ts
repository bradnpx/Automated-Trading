export function calculatePositionSize(
    accountEquity: number,
    entry: number,
    stop: number,
    riskPct = 0.01,
) {
    const maxRisk = accountEquity * riskPct;

    const riskPerShare = Math.abs(entry - stop);
    
    if (riskPerShare <= 0) {
        return 0
    }

    return Math.floor(maxRisk / riskPerShare);
}