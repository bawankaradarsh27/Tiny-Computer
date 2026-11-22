; ============================================================
; COUNTER for the TC-8
; Counts up forever. SCORE shows the count; row 8 of the screen
; shows a green bar that grows one cell per count and restarts
; every 16 counts.
; ============================================================

.equ FRAME,  0xF2        ; +1 every 2000 instructions
.equ SCORE,  0xF3        ; shown by the UI
.equ COUNT,  0x10        ; the counter (RAM)
.equ ROW,    0x80        ; screen address of row 8, x = 0
.equ TICKS,  4           ; frames per count (bigger = slower)

start:
        LDI  R0, 0
        STA  [COUNT], R0
        STA  [SCORE], R0
loop:
        LDA  R0, [COUNT]
        MOV  R1, R0
        ANDI R1, 15             ; R1 = x = count mod 16
        JNZ  draw
        CALL clear_row          ; bar is full (or just started): wipe it
draw:
        ADDI R1, ROW            ; R1 = screen address of cell x
        LDI  R2, 1
        VST  [R1], R2           ; paint it green
        ADDI R0, 1              ; count++
        STA  [COUNT], R0
        STA  [SCORE], R0
        LDI  R5, TICKS
        CALL wait_frames
        JMP  loop

; ------------------------------------------------------------
; clear_row: paint row 8 dark (uses R3, R4, R6)
; ------------------------------------------------------------
clear_row:
        LDI  R3, ROW
        LDI  R4, 0
        LDI  R6, 16
cr_loop:
        VST  [R3], R4
        ADDI R3, 1
        SUBI R6, 1
        JNZ  cr_loop
        RET

; ------------------------------------------------------------
; wait_frames: wait for R5 FRAME changes (uses R3, R4, R5)
; ------------------------------------------------------------
wait_frames:
        LDA  R3, [FRAME]
wf_loop:
        LDA  R4, [FRAME]
        CMP  R3, R4
        JZ   wf_loop
        MOV  R3, R4
        SUBI R5, 1
        JNZ  wf_loop
        RET
