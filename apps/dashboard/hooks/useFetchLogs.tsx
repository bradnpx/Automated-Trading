import { useState } from "react";

interface FetchStatus<T = any> {
    isLoading: boolean;
    data: T;
    errorMsg: Error | string | null
}

export default function useFetchLogs() {
    const [status, setStatus] = useState<FetchStatus>({
        isLoading: true,
        data: null,
        errorMsg: null
    })

}