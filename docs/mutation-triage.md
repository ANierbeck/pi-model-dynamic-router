# Mutation Survivor Triage Ledger

> Companion to docs/plans/2026-10-04-mutation-survivor-triage.md (Part A =
> operating model, Part B = batches). One row per undetected mutant (or
> tight line cluster); verdicts are filled batch-by-batch. New nightly
> reports are triaged against THIS ledger: a survivor already carrying a
> verdict stays parked; only new/changed entries become work items.

## Verdicts

- **REAL GAP** -> red-first test (AGENTS.md §4)
- **EQUIVALENT** -> behavior-identical; parked with rationale
- **DEFENSIVE/FAILOPEN** -> documented error path; parked
- **DEAD CODE** -> remove (§7)
- **UNTRIAGED** -> not yet classified (default)

## Baseline: report #1 (2026-10-04, 125.5 min, decision core)

| File | Score | Killed | Survived | NoCoverage |
|---|---|---|---|---|
| src/metrics.ts | 55.7% | 389 | 219 | 91 |
| src/routing.ts | 57.0% | 553 | 249 | 169 |
| **total** | **56.4%** | **942** | **468** | **260** |

## Open hotspots (from the triage plan, Part B)

| Cluster | Undetected | Batch |
|---|---|---|
| routing.ts:600-760 (cost window / cooldown) | 119 | Batch 1 (Task 2) |
| metrics.ts:900-1000 (pricing lookup) | 64 | Batch 2 (Task 3) |
| metrics.ts:100-350 (model-map / alias index) | 74 | Batch 3 (Task 4) |
| routing.ts:1000-1100 | 68 | Batch 3/5 |
| No-coverage clusters (by function) | see below | Task 5 |


## HOTSPOT routing.ts:600-760 (119 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 602 | BooleanLiteral | Survived | UNTRIAGED | |
| 602 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 603 | ObjectLiteral | Survived | UNTRIAGED | |
| 612 | MethodExpression | Survived | UNTRIAGED | |
| 618 | BlockStatement | NoCoverage | UNTRIAGED | |
| 619 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 619 | ConditionalExpression ×3 | NoCoverage | UNTRIAGED | |
| 619 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 619 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 620 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 620 | ArrowFunction ×2 | NoCoverage | UNTRIAGED | |
| 620 | MethodExpression | NoCoverage | UNTRIAGED | |
| 621 | ArithmeticOperator ×3 | NoCoverage | UNTRIAGED | |
| 623 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 623 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 623 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 623 | MethodExpression | NoCoverage | UNTRIAGED | |
| 629 | BlockStatement | NoCoverage | UNTRIAGED | |
| 630 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 630 | ConditionalExpression ×3 | NoCoverage | UNTRIAGED | |
| 630 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 630 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 631 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 631 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 631 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 631 | MethodExpression | NoCoverage | UNTRIAGED | |
| 643 | ConditionalExpression | Survived | UNTRIAGED | |
| 643 | StringLiteral | Survived | UNTRIAGED | |
| 644 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 644 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 644 | MethodExpression | NoCoverage | UNTRIAGED | |
| 645 | ConditionalExpression | Survived | UNTRIAGED | |
| 645 | StringLiteral | Survived | UNTRIAGED | |
| 646 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 646 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 646 | MethodExpression | NoCoverage | UNTRIAGED | |
| 647 | ConditionalExpression | Survived | UNTRIAGED | |
| 647 | StringLiteral | Survived | UNTRIAGED | |
| 651 | ConditionalExpression | Survived | UNTRIAGED | |
| 651 | StringLiteral | Survived | UNTRIAGED | |
| 652 | ArithmeticOperator | Survived | UNTRIAGED | |
| 652 | ArrowFunction | Survived | UNTRIAGED | |
| 652 | MethodExpression | Survived | UNTRIAGED | |
| 653 | ConditionalExpression | Survived | UNTRIAGED | |
| 666 | ConditionalExpression | Survived | UNTRIAGED | |
| 666 | EqualityOperator | Survived | UNTRIAGED | |
| 668 | EqualityOperator | Survived | UNTRIAGED | |
| 669 | ConditionalExpression | Survived | UNTRIAGED | |
| 676 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 676 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 676 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 676 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 676 | EqualityOperator | Survived | UNTRIAGED | |
| 676 | LogicalOperator | Survived | UNTRIAGED | |
| 676 | StringLiteral | NoCoverage | UNTRIAGED | |
| 676 | StringLiteral | Survived | UNTRIAGED | |
| 677 | ConditionalExpression | Survived | UNTRIAGED | |
| 677 | StringLiteral | Survived | UNTRIAGED | |
| 678 | ConditionalExpression | Survived | UNTRIAGED | |
| 678 | StringLiteral | Survived | UNTRIAGED | |
| 678 | UnaryOperator | NoCoverage | UNTRIAGED | |
| 679 | ArithmeticOperator | Survived | UNTRIAGED | |
| 688 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 688 | EqualityOperator | Survived | UNTRIAGED | |
| 688 | StringLiteral | Survived | UNTRIAGED | |
| 689 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 689 | EqualityOperator | Survived | UNTRIAGED | |
| 689 | StringLiteral | Survived | UNTRIAGED | |
| 712 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 720 | ArrowFunction | Survived | UNTRIAGED | |
| 720 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 730 | ConditionalExpression | Survived | UNTRIAGED | |
| 730 | StringLiteral | Survived | UNTRIAGED | |
| 732 | ConditionalExpression | Survived | UNTRIAGED | |
| 743 | BlockStatement | Survived | UNTRIAGED | |
| 743 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 743 | EqualityOperator | Survived | UNTRIAGED | |
| 746 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 746 | ConditionalExpression | Survived | UNTRIAGED | |
| 751 | BlockStatement | Survived | UNTRIAGED | |
| 751 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 751 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 751 | LogicalOperator | Survived | UNTRIAGED | |
| 751 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 752 | ConditionalExpression | Survived | UNTRIAGED | |
| 752 | StringLiteral | Survived | UNTRIAGED | |
| 753 | ConditionalExpression | Survived | UNTRIAGED | |
| 753 | StringLiteral | Survived | UNTRIAGED | |
| 753 | UnaryOperator | NoCoverage | UNTRIAGED | |
| 754 | ArithmeticOperator | Survived | UNTRIAGED | |
| 754 | ConditionalExpression | Survived | UNTRIAGED | |

## HOTSPOT metrics.ts:900-1000 (64 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 901 | ConditionalExpression | Survived | UNTRIAGED | |
| 908 | ConditionalExpression | Survived | UNTRIAGED | |
| 909 | OptionalChaining | Survived | UNTRIAGED | |
| 910 | ConditionalExpression | Survived | UNTRIAGED | |
| 912 | ConditionalExpression | Survived | UNTRIAGED | |
| 912 | OptionalChaining | Survived | UNTRIAGED | |
| 914 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 914 | LogicalOperator | Survived | UNTRIAGED | |
| 919 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 919 | LogicalOperator | Survived | UNTRIAGED | |
| 921 | BlockStatement | NoCoverage | UNTRIAGED | |
| 945 | BlockStatement | Survived | UNTRIAGED | |
| 945 | ConditionalExpression | Survived | UNTRIAGED | |
| 947 | BlockStatement | NoCoverage | UNTRIAGED | |
| 947 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 947 | EqualityOperator | Survived | UNTRIAGED | |
| 947 | StringLiteral | Survived | UNTRIAGED | |
| 948 | ObjectLiteral | NoCoverage | UNTRIAGED | |
| 948 | StringLiteral ×2 | NoCoverage | UNTRIAGED | |
| 950 | ObjectLiteral | Survived | UNTRIAGED | |
| 957 | BlockStatement | Survived | UNTRIAGED | |
| 957 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 957 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 957 | LogicalOperator | Survived | UNTRIAGED | |
| 959 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 959 | ConditionalExpression | Survived | UNTRIAGED | |
| 960 | StringLiteral | Survived | UNTRIAGED | |
| 961 | ArrayDeclaration | Survived | UNTRIAGED | |
| 961 | LogicalOperator | Survived | UNTRIAGED | |
| 961 | OptionalChaining ×2 | Survived | UNTRIAGED | |
| 963 | ConditionalExpression | Survived | UNTRIAGED | |
| 963 | OptionalChaining | Survived | UNTRIAGED | |
| 967 | ObjectLiteral | NoCoverage | UNTRIAGED | |
| 967 | StringLiteral ×2 | NoCoverage | UNTRIAGED | |
| 975 | BlockStatement | Survived | UNTRIAGED | |
| 976 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 976 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 977 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 977 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 977 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 977 | MethodExpression | NoCoverage | UNTRIAGED | |
| 977 | StringLiteral ×2 | NoCoverage | UNTRIAGED | |
| 978 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 978 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 982 | BlockStatement | NoCoverage | UNTRIAGED | |
| 982 | ConditionalExpression | Survived | UNTRIAGED | |
| 984 | ObjectLiteral | NoCoverage | UNTRIAGED | |

## HOTSPOT metrics.ts:100-350 (74 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 110 | UpdateOperator | Survived | UNTRIAGED | |
| 130 | ConditionalExpression | Survived | UNTRIAGED | |
| 130 | UnaryOperator | Survived | UNTRIAGED | |
| 144 | ConditionalExpression | Survived | UNTRIAGED | |
| 146 | BlockStatement | Survived | UNTRIAGED | |
| 147 | ConditionalExpression | Survived | UNTRIAGED | |
| 147 | MethodExpression | Survived | UNTRIAGED | |
| 165 | UnaryOperator | Survived | UNTRIAGED | |
| 174 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 174 | LogicalOperator | Survived | UNTRIAGED | |
| 176 | ConditionalExpression | Survived | UNTRIAGED | |
| 177 | ArrayDeclaration | Survived | UNTRIAGED | |
| 190 | ArrayDeclaration | Survived | UNTRIAGED | |
| 190 | ConditionalExpression | Survived | UNTRIAGED | |
| 191 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 191 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 191 | LogicalOperator | Survived | UNTRIAGED | |
| 194 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 194 | ConditionalExpression | Survived | UNTRIAGED | |
| 194 | MethodExpression | Survived | UNTRIAGED | |
| 202 | BlockStatement | Survived | UNTRIAGED | |
| 203 | ArrayDeclaration | Survived | UNTRIAGED | |
| 203 | MethodExpression | Survived | UNTRIAGED | |
| 203 | StringLiteral | Survived | UNTRIAGED | |
| 205 | CallExpression | Survived | UNTRIAGED | |
| 205 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 205 | EqualityOperator ×3 | Survived | UNTRIAGED | |
| 205 | LogicalOperator | Survived | UNTRIAGED | |
| 249 | BlockStatement | Survived | UNTRIAGED | |
| 251 | StringLiteral | Survived | UNTRIAGED | |
| 252 | ArrowFunction | Survived | UNTRIAGED | |
| 252 | Regex ×4 | Survived | UNTRIAGED | |
| 252 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 253 | StringLiteral | Survived | UNTRIAGED | |
| 278 | BlockStatement | Survived | UNTRIAGED | |
| 278 | ConditionalExpression | Survived | UNTRIAGED | |
| 280 | BlockStatement | Survived | UNTRIAGED | |
| 282 | BlockStatement | Survived | UNTRIAGED | |
| 282 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 282 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 282 | LogicalOperator ×2 | Survived | UNTRIAGED | |
| 283 | CallExpression | Survived | UNTRIAGED | |
| 299 | UpdateOperator | Survived | UNTRIAGED | |
| 318 | MethodExpression | Survived | UNTRIAGED | |
| 319 | ConditionalExpression | Survived | UNTRIAGED | |
| 321 | UpdateOperator | Survived | UNTRIAGED | |
| 330 | ConditionalExpression | Survived | UNTRIAGED | |
| 335 | ConditionalExpression | Survived | UNTRIAGED | |
| 335 | EqualityOperator | Survived | UNTRIAGED | |
| 346 | OptionalChaining | Survived | UNTRIAGED | |
| 347 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 347 | EqualityOperator | Survived | UNTRIAGED | |
| 347 | LogicalOperator ×2 | Survived | UNTRIAGED | |
| 347 | StringLiteral | Survived | UNTRIAGED | |

## HOTSPOT routing.ts:1000-1100 (68 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 1024 | ConditionalExpression | Survived | UNTRIAGED | |
| 1025 | MethodExpression | Survived | UNTRIAGED | |
| 1060 | StringLiteral | Survived | UNTRIAGED | |
| 1061 | BlockStatement | Survived | UNTRIAGED | |
| 1061 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1061 | EqualityOperator | Survived | UNTRIAGED | |
| 1061 | StringLiteral | Survived | UNTRIAGED | |
| 1064 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1064 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1064 | EqualityOperator | Survived | UNTRIAGED | |
| 1064 | LogicalOperator | Survived | UNTRIAGED | |
| 1064 | StringLiteral | Survived | UNTRIAGED | |
| 1065 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1067 | ConditionalExpression ×3 | NoCoverage | UNTRIAGED | |
| 1067 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1067 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1067 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1069 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1069 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1069 | EqualityOperator | Survived | UNTRIAGED | |
| 1069 | StringLiteral | Survived | UNTRIAGED | |
| 1070 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1070 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1071 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1072 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1072 | MethodExpression ×2 | NoCoverage | UNTRIAGED | |
| 1073 | BlockStatement | Survived | UNTRIAGED | |
| 1073 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1073 | EqualityOperator | Survived | UNTRIAGED | |
| 1073 | StringLiteral | Survived | UNTRIAGED | |
| 1074 | StringLiteral | Survived | UNTRIAGED | |
| 1075 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1075 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1075 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1075 | LogicalOperator | Survived | UNTRIAGED | |
| 1075 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1076 | BlockStatement | Survived | UNTRIAGED | |
| 1078 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1078 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1078 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1078 | LogicalOperator | Survived | UNTRIAGED | |
| 1078 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1090 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1091 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1097 | MethodExpression ×2 | NoCoverage | UNTRIAGED | |
| 1098 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 1098 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1098 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1098 | StringLiteral | NoCoverage | UNTRIAGED | |
| 1099 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1099 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 1099 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |

## REST metrics.ts (172 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 52 | ArrayDeclaration | Survived | UNTRIAGED | |
| 57 | UnaryOperator | Survived | UNTRIAGED | |
| 62 | BlockStatement | Survived | UNTRIAGED | |
| 63 | StringLiteral | Survived | UNTRIAGED | |
| 64 | BlockStatement | Survived | UNTRIAGED | |
| 67 | ArrayDeclaration | Survived | UNTRIAGED | |
| 68 | BlockStatement | Survived | UNTRIAGED | |
| 69 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 69 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 69 | LogicalOperator | Survived | UNTRIAGED | |
| 69 | StringLiteral | Survived | UNTRIAGED | |
| 70 | BlockStatement | Survived | UNTRIAGED | |
| 70 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 70 | MethodExpression | Survived | UNTRIAGED | |
| 70 | StringLiteral | Survived | UNTRIAGED | |
| 71 | ArrayDeclaration | Survived | UNTRIAGED | |
| 71 | MethodExpression | Survived | UNTRIAGED | |
| 72 | BlockStatement | Survived | UNTRIAGED | |
| 77 | ArithmeticOperator | Survived | UNTRIAGED | |
| 77 | ArrowFunction | Survived | UNTRIAGED | |
| 77 | MethodExpression | Survived | UNTRIAGED | |
| 79 | BlockStatement | NoCoverage | UNTRIAGED | |
| 84 | StringLiteral | NoCoverage | UNTRIAGED | |
| 86 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 87 | UpdateOperator | NoCoverage | UNTRIAGED | |
| 96 | UpdateOperator | Survived | UNTRIAGED | |
| 355 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 355 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 355 | LogicalOperator | Survived | UNTRIAGED | |
| 377 | ConditionalExpression | Survived | UNTRIAGED | |
| 381 | ConditionalExpression | Survived | UNTRIAGED | |
| 386 | ArrayDeclaration | Survived | UNTRIAGED | |
| 386 | MethodExpression | Survived | UNTRIAGED | |
| 386 | StringLiteral | Survived | UNTRIAGED | |
| 393 | ObjectLiteral | Survived | UNTRIAGED | |
| 425 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 425 | EqualityOperator | Survived | UNTRIAGED | |
| 425 | LogicalOperator | Survived | UNTRIAGED | |
| 428 | OptionalChaining | Survived | UNTRIAGED | |
| 429 | ConditionalExpression | Survived | UNTRIAGED | |
| 438 | ArrayDeclaration | Survived | UNTRIAGED | |
| 509 | BlockStatement | Survived | UNTRIAGED | |
| 518 | BlockStatement | Survived | UNTRIAGED | |
| 518 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 522 | CallExpression | Survived | UNTRIAGED | |
| 523 | UpdateOperator | Survived | UNTRIAGED | |
| 536 | ConditionalExpression | Survived | UNTRIAGED | |
| 539 | ConditionalExpression | Survived | UNTRIAGED | |
| 544 | ConditionalExpression | Survived | UNTRIAGED | |
| 548 | UpdateOperator | Survived | UNTRIAGED | |
| 574 | ConditionalExpression | Survived | UNTRIAGED | |
| 582 | BlockStatement | NoCoverage | UNTRIAGED | |
| 618 | BlockStatement | Survived | UNTRIAGED | |
| 618 | ConditionalExpression | Survived | UNTRIAGED | |
| 628 | ArrayDeclaration | Survived | UNTRIAGED | |
| 628 | ArrowFunction | Survived | UNTRIAGED | |
| 628 | ConditionalExpression | Survived | UNTRIAGED | |
| 628 | StringLiteral | Survived | UNTRIAGED | |
| 629 | BlockStatement | Survived | UNTRIAGED | |
| 629 | ConditionalExpression | Survived | UNTRIAGED | |
| 647 | BlockStatement | Survived | UNTRIAGED | |
| 647 | ConditionalExpression | Survived | UNTRIAGED | |
| 660 | BlockStatement | Survived | UNTRIAGED | |
| 660 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 660 | LogicalOperator | Survived | UNTRIAGED | |
| 660 | StringLiteral | Survived | UNTRIAGED | |
| 681 | LogicalOperator | Survived | UNTRIAGED | |
| 682 | LogicalOperator | Survived | UNTRIAGED | |
| 691 | BlockStatement | NoCoverage | UNTRIAGED | |
| 694 | ArithmeticOperator ×4 | NoCoverage | UNTRIAGED | |
| 695 | BlockStatement | NoCoverage | UNTRIAGED | |
| 695 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 695 | EqualityOperator ×4 | NoCoverage | UNTRIAGED | |
| 695 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 696 | ArithmeticOperator ×6 | NoCoverage | UNTRIAGED | |
| 697 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 697 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 737 | ConditionalExpression | Survived | UNTRIAGED | |
| 776 | BlockStatement | Survived | UNTRIAGED | |
| 776 | ConditionalExpression | Survived | UNTRIAGED | |
| 778 | BooleanLiteral | Survived | UNTRIAGED | |
| 778 | ConditionalExpression | Survived | UNTRIAGED | |
| 779 | MethodExpression | Survived | UNTRIAGED | |
| 779 | StringLiteral ×3 | Survived | UNTRIAGED | |
| 780 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 780 | ConditionalExpression | Survived | UNTRIAGED | |
| 781 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 781 | ConditionalExpression | Survived | UNTRIAGED | |
| 781 | StringLiteral | Survived | UNTRIAGED | |
| 784 | ArrayDeclaration | Survived | UNTRIAGED | |
| 807 | StringLiteral | Survived | UNTRIAGED | |
| 818 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 819 | MethodExpression | NoCoverage | UNTRIAGED | |
| 819 | StringLiteral ×3 | NoCoverage | UNTRIAGED | |
| 820 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 821 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 821 | StringLiteral | NoCoverage | UNTRIAGED | |
| 823 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 880 | LogicalOperator | Survived | UNTRIAGED | |
| 880 | StringLiteral | Survived | UNTRIAGED | |
| 891 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1014 | ConditionalExpression | Survived | UNTRIAGED | |
| 1017 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1017 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1017 | EqualityOperator | Survived | UNTRIAGED | |
| 1019 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1019 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1020 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1020 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 1020 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1020 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1020 | StringLiteral ×2 | NoCoverage | UNTRIAGED | |
| 1021 | StringLiteral | NoCoverage | UNTRIAGED | |
| 1028 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1028 | ConditionalExpression | Survived | UNTRIAGED | |
| 1031 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1031 | OptionalChaining | NoCoverage | UNTRIAGED | |
| 1034 | OptionalChaining ×2 | NoCoverage | UNTRIAGED | |
| 1035 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1035 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1035 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1053 | ArithmeticOperator | Survived | UNTRIAGED | |
| 1070 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1071 | EqualityOperator | Survived | UNTRIAGED | |
| 1081 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1082 | EqualityOperator | Survived | UNTRIAGED | |

## REST routing.ts (231 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 48 | BooleanLiteral | Survived | UNTRIAGED | |
| 49 | LogicalOperator | Survived | UNTRIAGED | |
| 69 | BooleanLiteral | Survived | UNTRIAGED | |
| 69 | ConditionalExpression | Survived | UNTRIAGED | |
| 88 | BlockStatement | Survived | UNTRIAGED | |
| 89 | OptionalChaining | Survived | UNTRIAGED | |
| 89 | StringLiteral | Survived | UNTRIAGED | |
| 98 | OptionalChaining | Survived | UNTRIAGED | |
| 115 | BlockStatement | Survived | UNTRIAGED | |
| 116 | StringLiteral | Survived | UNTRIAGED | |
| 117 | OptionalChaining | Survived | UNTRIAGED | |
| 118 | ConditionalExpression | Survived | UNTRIAGED | |
| 119 | ArithmeticOperator | Survived | UNTRIAGED | |
| 119 | MethodExpression | Survived | UNTRIAGED | |
| 120 | ConditionalExpression | Survived | UNTRIAGED | |
| 120 | LogicalOperator | Survived | UNTRIAGED | |
| 133 | ConditionalExpression | Survived | UNTRIAGED | |
| 133 | LogicalOperator | Survived | UNTRIAGED | |
| 135 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 135 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 135 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 135 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 135 | EqualityOperator | Survived | UNTRIAGED | |
| 214 | BooleanLiteral | Survived | UNTRIAGED | |
| 239 | LogicalOperator | Survived | UNTRIAGED | |
| 257 | ConditionalExpression | Survived | UNTRIAGED | |
| 258 | ConditionalExpression | Survived | UNTRIAGED | |
| 258 | EqualityOperator | Survived | UNTRIAGED | |
| 259 | BlockStatement | NoCoverage | UNTRIAGED | |
| 259 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 259 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 259 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 259 | EqualityOperator | Survived | UNTRIAGED | |
| 259 | LogicalOperator | Survived | UNTRIAGED | |
| 263 | ArrowFunction ×2 | NoCoverage | UNTRIAGED | |
| 263 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 263 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 263 | MethodExpression | NoCoverage | UNTRIAGED | |
| 264 | BlockStatement | NoCoverage | UNTRIAGED | |
| 264 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 265 | MethodExpression | NoCoverage | UNTRIAGED | |
| 266 | ArithmeticOperator ×2 | NoCoverage | UNTRIAGED | |
| 267 | BlockStatement | NoCoverage | UNTRIAGED | |
| 267 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 267 | EqualityOperator ×3 | NoCoverage | UNTRIAGED | |
| 267 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 267 | MethodExpression | NoCoverage | UNTRIAGED | |
| 275 | ConditionalExpression | Survived | UNTRIAGED | |
| 276 | ConditionalExpression | Survived | UNTRIAGED | |
| 276 | EqualityOperator | Survived | UNTRIAGED | |
| 287 | ConditionalExpression | Survived | UNTRIAGED | |
| 289 | ConditionalExpression | Survived | UNTRIAGED | |
| 289 | StringLiteral | Survived | UNTRIAGED | |
| 290 | EqualityOperator | Survived | UNTRIAGED | |
| 301 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 301 | StringLiteral | Survived | UNTRIAGED | |
| 302 | EqualityOperator | Survived | UNTRIAGED | |
| 309 | ConditionalExpression | Survived | UNTRIAGED | |
| 312 | ConditionalExpression | Survived | UNTRIAGED | |
| 312 | EqualityOperator | Survived | UNTRIAGED | |
| 325 | ArrayDeclaration | Survived | UNTRIAGED | |
| 326 | StringLiteral ×8 | Survived | UNTRIAGED | |
| 351 | OptionalChaining | Survived | UNTRIAGED | |
| 360 | EqualityOperator | Survived | UNTRIAGED | |
| 380 | ConditionalExpression | Survived | UNTRIAGED | |
| 380 | UnaryOperator | Survived | UNTRIAGED | |
| 422 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 422 | EqualityOperator | Survived | UNTRIAGED | |
| 422 | LogicalOperator | Survived | UNTRIAGED | |
| 435 | ConditionalExpression | Survived | UNTRIAGED | |
| 449 | ConditionalExpression | Survived | UNTRIAGED | |
| 463 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 463 | EqualityOperator | Survived | UNTRIAGED | |
| 463 | LogicalOperator | Survived | UNTRIAGED | |
| 481 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 481 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 481 | LogicalOperator | Survived | UNTRIAGED | |
| 520 | ConditionalExpression | Survived | UNTRIAGED | |
| 546 | LogicalOperator | Survived | UNTRIAGED | |
| 585 | ConditionalExpression | Survived | UNTRIAGED | |
| 773 | BlockStatement | NoCoverage | UNTRIAGED | |
| 773 | ConditionalExpression | Survived | UNTRIAGED | |
| 773 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 774 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 776 | ConditionalExpression | Survived | UNTRIAGED | |
| 776 | StringLiteral | Survived | UNTRIAGED | |
| 777 | ConditionalExpression | Survived | UNTRIAGED | |
| 843 | ConditionalExpression | Survived | UNTRIAGED | |
| 843 | StringLiteral | Survived | UNTRIAGED | |
| 847 | ConditionalExpression | Survived | UNTRIAGED | |
| 850 | ArrayDeclaration | Survived | UNTRIAGED | |
| 850 | BlockStatement | Survived | UNTRIAGED | |
| 852 | BooleanLiteral | Survived | UNTRIAGED | |
| 852 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 854 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 890 | ConditionalExpression | Survived | UNTRIAGED | |
| 890 | UnaryOperator | Survived | UNTRIAGED | |
| 891 | CallExpression | Survived | UNTRIAGED | |
| 931 | LogicalOperator | Survived | UNTRIAGED | |
| 962 | LogicalOperator | Survived | UNTRIAGED | |
| 963 | LogicalOperator | Survived | UNTRIAGED | |
| 966 | EqualityOperator | Survived | UNTRIAGED | |
| 980 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 980 | Regex | Survived | UNTRIAGED | |
| 982 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 982 | Regex ×7 | Survived | UNTRIAGED | |
| 984 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 984 | Regex ×2 | Survived | UNTRIAGED | |
| 1101 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1101 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1101 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1102 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1103 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1104 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1104 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1104 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1111 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1111 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1111 | StringLiteral ×5 | NoCoverage | UNTRIAGED | |
| 1113 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1113 | ConditionalExpression ×5 | NoCoverage | UNTRIAGED | |
| 1113 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1113 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |
| 1130 | BlockStatement | Survived | UNTRIAGED | |
| 1183 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1183 | ConditionalExpression | Survived | UNTRIAGED | |
| 1183 | ObjectLiteral | NoCoverage | UNTRIAGED | |
| 1184 | ArrayDeclaration | Survived | UNTRIAGED | |
| 1184 | ConditionalExpression | Survived | UNTRIAGED | |
| 1184 | ObjectLiteral | Survived | UNTRIAGED | |
| 1184 | StringLiteral | Survived | UNTRIAGED | |
| 1196 | BooleanLiteral | Survived | UNTRIAGED | |
| 1198 | BlockStatement | Survived | UNTRIAGED | |
| 1198 | ConditionalExpression | Survived | UNTRIAGED | |
| 1198 | StringLiteral | Survived | UNTRIAGED | |
| 1202 | LogicalOperator | Survived | UNTRIAGED | |
| 1202 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 1203 | BlockStatement | Survived | UNTRIAGED | |
| 1203 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1203 | EqualityOperator | Survived | UNTRIAGED | |
| 1203 | StringLiteral | Survived | UNTRIAGED | |
| 1205 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1205 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1205 | EqualityOperator | Survived | UNTRIAGED | |
| 1205 | LogicalOperator | Survived | UNTRIAGED | |
| 1205 | StringLiteral | Survived | UNTRIAGED | |
| 1206 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1206 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1206 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1206 | UpdateOperator | NoCoverage | UNTRIAGED | |
| 1210 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1210 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1210 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1211 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 1211 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 1211 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1211 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |
| 1211 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1213 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1213 | EqualityOperator | Survived | UNTRIAGED | |
| 1213 | StringLiteral | Survived | UNTRIAGED | |
| 1215 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1233 | ArrowFunction | Survived | UNTRIAGED | |
| 1234 | MethodExpression | Survived | UNTRIAGED | |
| 1235 | ArrowFunction | Survived | UNTRIAGED | |
| 1244 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1248 | BlockStatement | Survived | UNTRIAGED | |

## No-coverage clusters (Task 5 orientation)

| function | NoCoverage mutants |
|---|---|
| routing.ts: export function isVirtualGroupRef(ref: string, groupNames: R | 140 |
| routing.ts: export function applyGroupFilters( | 26 |
| metrics.ts: export function effCost(ref: string): number | 'unknown' { | 25 |
| metrics.ts: export function updateMetrics(ref: string, latMs: number, to | 24 |
| metrics.ts: export function lookupPrice(ref: string): { input: number |  | 21 |
| metrics.ts: export function billingTier(ref: string): number { | 10 |
| metrics.ts: export function loadModelMap(extDir: string): void { | 4 |
| routing.ts: function liveGroupFilterLookups(cfg: Config): GroupFilterLoo | 3 |
| metrics.ts: export function isFreeModelRef( | 2 |
| metrics.ts: function aliasesFor(modelId: string): string[] { | 1 |
| metrics.ts: export function getCapabilityProfiles(): NonNullable<Cache[' | 1 |
| metrics.ts: function registryCost( | 1 |
