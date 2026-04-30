"use client";
import { useEffect, useState, useRef } from "react";

interface PriceCellProps {
    price: number;
    direction: 'up' | 'down' | 'flat';
}

export default function PriceCell({ price, direction }: PriceCellProps) {
    const [flashClass, setFlashClass] = useState("")
    const prevPriceRef = useRef(price);

    useEffect(() => {
        if (prevPriceRef.current !== price) {
            const colorClass = direction === "up" ? "bg-green-200" : "bg-red-200"
            setFlashClass(colorClass);

            const timer = setTimeout(() => setFlashClass(""), 300);
            prevPriceRef.current = price;
            return () => clearTimeout(timer);
        }
    }, [price, direction])

    return (
        <div className={`px-2 py-1 rounded transition-colors duration-500 font-mono ${flashClass}`}>
            ${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </div>

    )
}