"use client";

import { useState, useEffect } from "react";
import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

export function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);
  const [isClicked, setIsClicked] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsVisible(window.scrollY > 400);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    // Check initial scroll position
    handleScroll();

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToTop = () => {
    setIsClicked(true);
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
    
    setTimeout(() => {
      setIsClicked(false);
    }, 400); // revert color back after 400ms
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 20 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          className="fixed bottom-6 right-6 z-50 sm:bottom-8 sm:right-8"
        >
          <button
            onClick={scrollToTop}
            aria-label="Scroll to top"
            className="flex h-12 w-12 items-center justify-center brutal-border bg-[var(--color-surface-1)] text-[var(--color-fg-primary)] shadow-[4px_4px_0_0_var(--color-fg-primary)] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_var(--color-fg-primary)] focus-visible:outline-none focus-visible:translate-x-[2px] focus-visible:translate-y-[2px] focus-visible:shadow-[2px_2px_0_0_var(--color-fg-primary)]"
          >
            <ArrowUp 
              className={`h-6 w-6 stroke-[3] transition-colors duration-200 ${isClicked ? "text-[#f97316]" : ""}`} 
            />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
