# Tower of Habit

A social accountability app where groups build a shared tower by maintaining habits together. The tower grows when everyone meets their commitments and collapses when they don't.

## Tower mechanics

**Tower**:
A shared structure built by a group of members, each contributing through their own habit. The tower grows by one unit of height for each period the group collectively survives.
_Avoid_: Group, team, challenge

**Run**:
A consecutive sequence of survived periods. A run begins when the tower starts (or restarts after a collapse) and ends on the next collapse.
_Avoid_: Streak (overloaded with current streak count)

**Run height**:
The number of survived periods in the current run. Stored as `currentStreak` in the database. Resets to 0 on collapse.
_Avoid_: Current height, streak length

**Total height**:
The cumulative number of survived periods across all runs. Stored as `height` in the database. Never resets.
_Avoid_: Lifetime height, cumulative streak

**Base block**:
A frozen record of a completed run, created when the tower collapses. Stores the run's height, date range, and member roster at time of collapse.
_Avoid_: Layer, stratum, history block

**Collapse**:
The event when a live member fails to meet quota for a period. Ends the current run, creates a base block, and resets run height to 0. A collapse is the tower's event, not attributed to any individual.
_Avoid_: Failure, reset, fall

**Period**:
A recurring time window (e.g. one week) during which members must meet their quota. Defined by the tower's `periodUnit` and `periodLength`.
_Avoid_: Cycle, round, interval

## Membership

**Host**:
The member who created the tower. Can remove other members from the lobby and start the tower.
_Avoid_: Creator, owner, admin

**Lobby**:
The pre-start state of a tower where the host shares the join code and members assemble. The tower transitions from lobby to active when the host starts it.
_Avoid_: Waiting room, staging

**Dormant**:
A membership state where the member is excused from quota obligations. Causes include consecutive misses, backstop rules, or voluntary absence.
_Avoid_: Inactive, paused, suspended

## Streak shield

**Streak shield**:
A tower-wide buffer earned when active members survive a period while another member is on a declared absence. One shield is earned per survived period during any absence. Shields auto-consume to prevent a collapse when a member misses quota. Maximum 3 shields per tower.
_Avoid_: Freebie, buffer, credit, immunity

## Absence

**Absence**:
A declared break from a tower, set in advance. Must be declared at least one full period before it starts. Maximum 14 days per single absence. No annual budget. The absent member goes dormant for the duration.
_Avoid_: Vacation, leave, break (too casual)
