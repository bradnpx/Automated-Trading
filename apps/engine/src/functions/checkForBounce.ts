import { Bar } from "@my-platform/types"

interface Props {
    sourceBar: Bar;
    targetBar: Bar;
}
export default function checkForBounce(props: Props): boolean {
    if (props.sourceBar.symbol !== props.targetBar.symbol) {
        return false;
    }

    return props.targetBar.high > props.sourceBar.close;
}