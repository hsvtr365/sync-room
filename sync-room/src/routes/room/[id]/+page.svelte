<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { db } from '$lib/db-client';
  import { 
    generateDates, 
    generateTimeSlots, 
    get15MinSubSlots, 
    isSubSlotUnavailable,
    isUnitAllowed,
    getRecommendedUnit,
    timeStringToMinutes,
    minutesToTimeString,
    type DateSlot,
    type TimeSlot
  } from '$lib/schedule-utils';

  const roomId = page.params.id;

  interface Room {
    id: string;
    title: string;
    range_days: number;
    time_start: string;
    time_end: string;
    display_unit: string;
    past_policy: string;
  }

  interface Participant {
    id: string;
    nickname: string;
    color: string;
    last_active_at: string;
  }

  interface UnavailableSlot {
    id: string;
    participant_id: string;
    start_at: string;
    end_at: string;
  }

  let room = $state<Room | null>(null);
  let participants = $state<Participant[]>([]);
  let unavailableSlots = $state<UnavailableSlot[]>([]);
  
  let mySession = $state<{ participant_id: string; nickname: string; color: string } | null>(null);
  let showJoinModal = $state(false);
  let joinNickname = $state('');
  let isJoining = $state(false);
  let joinError = $state('');

  // UI state
  let dates = $state<DateSlot[]>([]);
  let timeSlots = $state<TimeSlot[]>([]);
  let showSettings = $state(false);
  let highlightedParticipantId = $state<string | null>(null);
  let gridContainer = $state<HTMLDivElement | null>(null);
  
  // Track folded dates (e.g. yesterday starts folded by default)
  let foldedDates = $state<Record<string, boolean>>({});

  // Settings states
  let editTitle = $state('');
  let editRangeDays = $state(7);
  let editTimeStart = $state('08:00');
  let editTimeEnd = $state('24:00');
  let editDisplayUnit = $state('1hour');
  let editPastPolicy = $state('yesterday');
  let isSavingSettings = $state(false);

  // Drag state
  let isDragging = false;
  let dragMode: 'add' | 'remove' | null = null;
  let draggedCells = new Set<string>();

  // Realtime channel
  let realtimeChannel: any = null;

  // Optimistic state
  let optimisticAdd = $state<Omit<UnavailableSlot, 'id'>[]>([]);
  let optimisticRemove = $state<string[]>([]);

  async function fetchRoomData() {
    try {
      const { data: roomData, error: roomErr } = await db
        .from('rooms')
        .select('*')
        .eq('id', roomId)
        .single();

      if (roomErr || !roomData) {
        alert('방 정보를 찾을 수 없습니다.');
        goto('/');
        return;
      }

      room = roomData;
      editTitle = roomData.title;
      editRangeDays = roomData.range_days;
      editTimeStart = roomData.time_start;
      editTimeEnd = roomData.time_end;
      editDisplayUnit = roomData.display_unit;
      editPastPolicy = roomData.past_policy;

      refreshGridMeta();

      // Fetch participants
      const { data: partData, error: partErr } = await db
        .from('participants')
        .select('*')
        .eq('room_id', roomId);
      
      if (!partErr && partData) {
        participants = partData;
      }

      // Fetch unavailable slots
      const { data: slotData, error: slotErr } = await db
        .from('unavailable_slots')
        .select('*')
        .eq('room_id', roomId);
      
      if (!slotErr && slotData) {
        unavailableSlots = slotData;
      }
    } catch (e) {
      console.error(e);
    }
  }

  function refreshGridMeta() {
    if (!room) return;
    dates = generateDates(room.range_days, room.past_policy);
    timeSlots = generateTimeSlots(room.time_start, room.time_end, room.display_unit);

    // Initialize folded state: yesterday is folded by default
    const tempFolded: Record<string, boolean> = {};
    dates.forEach(d => {
      if (d.isYesterday || d.isPast) {
        tempFolded[d.dateStr] = true;
      } else {
        tempFolded[d.dateStr] = false;
      }
    });
    foldedDates = tempFolded;
  }

  onMount(async () => {
    const saved = localStorage.getItem(`room_session_${roomId}`);
    if (saved) {
      mySession = JSON.parse(saved);
    } else {
      showJoinModal = true;
    }

    await fetchRoomData();

    if (mySession) {
      updateActiveStatus();
    }

    realtimeChannel = db
      .channel(`room_realtime_${roomId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'participants', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newPart = payload.new as Participant;
            if (!participants.some(p => p.id === newPart.id)) {
              participants = [...participants, newPart];
            }
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Participant;
            participants = participants.map(p => p.id === updated.id ? updated : p);
          } else if (payload.eventType === 'DELETE') {
            const deleted = payload.old as { id: string };
            participants = participants.filter(p => p.id !== deleted.id);
            if (mySession?.participant_id === deleted.id) {
              alert('방에 대화 상대 목록에서 내보내졌습니다.');
              localStorage.removeItem(`room_session_${roomId}`);
              goto('/');
            }
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'unavailable_slots', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newSlot = payload.new as UnavailableSlot;
            if (!unavailableSlots.some(s => s.id === newSlot.id)) {
              unavailableSlots = [...unavailableSlots, newSlot];
            }
          } else if (payload.eventType === 'DELETE') {
            const deleted = payload.old as { id: string };
            unavailableSlots = unavailableSlots.filter(s => s.id !== deleted.id);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        (payload) => {
          room = payload.new as Room;
          refreshGridMeta();
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        () => {
          alert('방이 삭제되었습니다.');
          goto('/');
        }
      )
      .subscribe();
  });

  onDestroy(() => {
    if (realtimeChannel) {
      db.removeChannel(realtimeChannel);
    }
  });

  async function updateActiveStatus() {
    if (!mySession) return;
    await db
      .from('participants')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', mySession.participant_id);
  }

  async function handleJoinRoom(e: Event) {
    e.preventDefault();
    if (!joinNickname.trim() || !room) return;
    
    isJoining = true;
    joinError = '';
    
    try {
      const hue = Math.floor(Math.random() * 360);
      const color = `hsl(${hue}, 80%, 55%)`;
      
      const { data, error } = await db
        .from('participants')
        .insert({
          room_id: room.id,
          nickname: joinNickname.trim(),
          color
        })
        .select()
        .single();
      
      if (error) throw error;
      
      mySession = {
        participant_id: data.id,
        nickname: data.nickname,
        color: data.color
      };
      
      localStorage.setItem(`room_session_${room.id}`, JSON.stringify(mySession));
      showJoinModal = false;
      
      if (!participants.some(p => p.id === data.id)) {
        participants = [...participants, data];
      }
    } catch (err: any) {
      console.error(err);
      joinError = err.message || '입장 오류 발생';
    } finally {
      isJoining = false;
    }
  }

  let combinedSlots = $derived.by(() => {
    let list = [...unavailableSlots];
    if (optimisticRemove.length > 0) {
      list = list.filter(s => {
        const isRemoved = optimisticRemove.includes(s.start_at) && s.participant_id === mySession?.participant_id;
        return !isRemoved;
      });
    }
    if (mySession) {
      const adds = optimisticAdd.map(a => ({
        id: 'opt-id',
        ...a
      }));
      list = [...list, ...adds];
    }
    return list;
  });

  interface CellParticipant {
    id: string;
    nickname: string;
    color: string;
    isMe: boolean;
  }
  
  function getCellState(dateSlot: DateSlot, slot: TimeSlot) {
    if (!room) return { isMeUnavailable: false, list: [] as CellParticipant[] };

    const subSlots = get15MinSubSlots(dateSlot, room.time_start, slot);
    const cellParts: CellParticipant[] = [];
    let isMeUnavailable = false;

    for (const p of participants) {
      const userSlots = combinedSlots.filter(s => s.participant_id === p.id);
      const overlaps = subSlots.some(sub => 
        isSubSlotUnavailable(sub.startISO, sub.endISO, userSlots)
      );

      if (overlaps) {
        const isMe = p.id === mySession?.participant_id;
        if (isMe) isMeUnavailable = true;
        
        cellParts.push({
          id: p.id,
          nickname: p.nickname,
          color: p.color,
          isMe
        });
      }
    }

    cellParts.sort((a, b) => {
      if (a.isMe && !b.isMe) return 1;
      if (!a.isMe && b.isMe) return -1;
      return a.id.localeCompare(b.id);
    });

    return {
      isMeUnavailable,
      list: cellParts
    };
  }

  function startDrag(dateStr: string, slotIdx: number, isMeUnavailable: boolean) {
    if (!mySession || !room || foldedDates[dateStr]) return;
    
    isDragging = true;
    draggedCells.clear();
    dragMode = isMeUnavailable ? 'remove' : 'add';
    toggleCell(dateStr, slotIdx);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDragging || !mySession || !room) return;
    
    const element = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
    if (!element) return;
    
    const dateStr = element.getAttribute('data-date');
    const slotIdxStr = element.getAttribute('data-slot-idx');
    
    if (dateStr && slotIdxStr && !foldedDates[dateStr]) {
      const slotIdx = parseInt(slotIdxStr, 10);
      const key = `${dateStr}_${slotIdx}`;
      if (!draggedCells.has(key)) {
        toggleCell(dateStr, slotIdx);
      }
    }
  }

  function stopDrag() {
    isDragging = false;
    dragMode = null;
    draggedCells.clear();
  }

  async function toggleCell(dateStr: string, slotIdx: number) {
    if (!mySession || !room || !dragMode) return;

    const key = `${dateStr}_${slotIdx}`;
    draggedCells.add(key);

    const dateSlot = dates.find(d => d.dateStr === dateStr);
    const slot = timeSlots[slotIdx];
    if (!dateSlot || !slot) return;

    const subSlots = get15MinSubSlots(dateSlot, room.time_start, slot);
    
    if (dragMode === 'add') {
      const newLocalSlots = subSlots.map(sub => ({
        room_id: roomId,
        participant_id: mySession!.participant_id,
        start_at: sub.startISO,
        end_at: sub.endISO
      }));

      optimisticAdd = [...optimisticAdd, ...newLocalSlots];

      try {
        const { error } = await db
          .from('unavailable_slots')
          .insert(newLocalSlots);
        if (error) throw error;
      } catch (err) {
        console.error(err);
      } finally {
        // Clear from optimistic queue once DB operation completes
        optimisticAdd = optimisticAdd.filter(o => !newLocalSlots.some(n => n.start_at === o.start_at));
      }
    } else {
      const startTimes = subSlots.map(sub => sub.startISO);
      optimisticRemove = [...optimisticRemove, ...startTimes];

      try {
        const { error } = await db
          .from('unavailable_slots')
          .delete()
          .eq('room_id', roomId)
          .eq('participant_id', mySession.participant_id)
          .in('start_at', startTimes);
        if (error) throw error;
      } catch (err) {
        console.error(err);
      } finally {
        // Clear from optimistic queue once DB operation completes
        optimisticRemove = optimisticRemove.filter(time => !startTimes.includes(time));
      }
    }
  }

  function scrollToNow() {
    if (!gridContainer || !room) return;

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    // 가로 스크롤 위치 계산 (오늘 날짜 컬럼)
    const colEl = document.getElementById(`col-${todayStr}`);
    let targetLeft = 0;
    if (colEl) {
      const containerWidth = gridContainer.clientWidth;
      const colWidth = colEl.clientWidth;
      // colEl.offsetLeft는 gridContainer 내에서의 상대 좌표를 반환함
      // 중앙 배치를 위한 offset 계산 (시작 시간 컬럼 폭 64px 제외)
      targetLeft = colEl.offsetLeft - (containerWidth / 2) + (colWidth / 2) - 32;
      if (targetLeft < 0) targetLeft = 0;
    }

    // 세로 스크롤 위치 계산 (현재 시각 행)
    const curHour = today.getHours();
    const curMin = today.getMinutes();
    const totalMin = curHour * 60 + curMin;
    
    let closestRowId = '';
    let minDiff = Infinity;

    for (const slot of timeSlots) {
      const slotMin = timeSlots.indexOf(slot) * (slot.durationMin);
      const diff = Math.abs(slotMin - totalMin);
      if (diff < minDiff) {
        minDiff = diff;
        closestRowId = `row-${slot.label}`;
      }
    }

    let targetTop = 0;
    if (closestRowId) {
      const rowEl = document.getElementById(closestRowId);
      if (rowEl) {
        const containerHeight = gridContainer.clientHeight;
        const rowHeight = rowEl.clientHeight;
        // rowEl.offsetTop는 gridContainer 내에서의 상대 좌표
        targetTop = rowEl.offsetTop - (containerHeight / 2) + (rowHeight / 2);
        if (targetTop < 0) targetTop = 0;
      }
    }

    // 그리드 컨테이너만 직접 가로/세로 부드럽게 스크롤
    gridContainer.scrollTo({
      top: targetTop,
      left: targetLeft,
      behavior: 'smooth'
    });
  }

  async function handleUpdateSettings(e: Event) {
    e.preventDefault();
    if (!room || isSavingSettings) return;

    isSavingSettings = true;
    
    let finalUnit = editDisplayUnit;
    if (!isUnitAllowed(editTimeStart, editTimeEnd, editDisplayUnit)) {
      finalUnit = getRecommendedUnit(editTimeStart, editTimeEnd);
    }

    try {
      const { error } = await db
        .from('rooms')
        .update({
          title: editTitle.trim(),
          range_days: editRangeDays,
          time_start: editTimeStart,
          time_end: editTimeEnd,
          display_unit: finalUnit,
          past_policy: editPastPolicy
        })
        .eq('id', roomId);

      if (error) throw error;
      showSettings = false;
    } catch (err) {
      alert('설정 저장 실패: ' + (err as any).message);
    } finally {
      isSavingSettings = false;
    }
  }

  async function kickParticipant(participantId: string) {
    if (!confirm('이 참여자를 정말 제외하시겠습니까?')) return;
    try {
      const { error } = await db
        .from('participants')
        .delete()
        .eq('id', participantId);
      if (error) throw error;
    } catch (err) {
      alert('내보내기 실패: ' + (err as any).message);
    }
  }

  async function deleteRoom() {
    if (!confirm('방을 영구적으로 삭제하시겠습니까? 관련 데이터가 모두 삭제됩니다.')) return;
    try {
      const { error } = await db
        .from('rooms')
        .delete()
        .eq('id', roomId);
      if (error) throw error;
      goto('/');
    } catch (err) {
      alert('방 삭제 실패: ' + (err as any).message);
    }
  }

  function copyInviteLink() {
    const url = window.location.origin + '/?code=' + roomId;
    navigator.clipboard.writeText(url).then(() => {
      alert('초대 링크가 복사되었습니다!');
    }).catch(() => {
      alert('방 ID: ' + roomId);
    });
  }

  // Toggle dynamic fold/unfold for past/archive days
  function toggleFoldDate(dateStr: string) {
    foldedDates[dateStr] = !foldedDates[dateStr];
  }
</script>

<svelte:window onpointerup={stopDrag} />

<div class="app-container h-screen max-h-screen overflow-hidden bg-gray-50 flex flex-col justify-between">
  <!-- Join Modal Overlay (For sessionless visitors) -->
  {#if showJoinModal}
    <div class="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div class="bg-white border border-gray-100 rounded-3xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
        <div>
          <h2 class="text-lg font-extrabold text-gray-900">⏳ 모임 참여하기</h2>
          <p class="text-xs text-gray-500 mt-1">닉네임을 입력하고 그룹 일정 조율에 참여해 보세요.</p>
        </div>
        
        <form onsubmit={handleJoinRoom} class="space-y-4">
          <div>
            <label for="modal-nickname" class="block text-xs font-semibold text-gray-500 mb-1.5">내 닉네임</label>
            <input 
              id="modal-nickname"
              type="text" 
              bind:value={joinNickname} 
              placeholder="예: 홍길동" 
              class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all"
              required 
            />
          </div>

          {#if joinError}
            <div class="text-xs text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-xl text-center">
              {joinError}
            </div>
          {/if}

          <button 
            type="submit" 
            class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-sm transition-all active:scale-[0.98]"
            disabled={isJoining}
          >
            {#if isJoining}입장 중...{:else}입장 완료{/if}
          </button>
        </form>
      </div>
    </div>
  {/if}

  {#if room}
    <!-- Header -->
    <header class="bg-white/80 backdrop-blur-md border-b border-gray-100 px-4 py-3 sticky top-0 z-40 flex flex-col gap-1.5 shrink-0">
      <div class="flex justify-between items-center">
        <h1 class="text-lg font-bold text-gray-900 overflow-hidden text-ellipsis whitespace-nowrap max-w-[80%]">
          {room.title}
        </h1>
        <button 
          class="w-8 h-8 rounded-full bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-sm border border-gray-200/50 cursor-pointer active:scale-95 transition-all" 
          onclick={() => showSettings = true} 
          aria-label="방 설정 열기"
        >
          ⚙️
        </button>
      </div>
      
      <div class="flex justify-between items-center text-xs text-gray-500">
        <span>
          {dates.length > 0 ? `${dates[0].label} ~ ${dates[dates.length - 1].label}` : ''}
        </span>
        <button 
          class="bg-blue-50 text-blue-600 px-3 py-1 rounded-full font-semibold border border-blue-100 active:scale-95 transition-all" 
          onclick={copyInviteLink}
        >
          🔗 링크 복사
        </button>
      </div>
    </header>

    <!-- Main Scheduler Grid container -->
    <div 
      bind:this={gridContainer}
      class="flex-1 overflow-auto relative select-none touch-none"
      onpointermove={handlePointerMove}
      role="grid"
      aria-label="스케줄 보드"
      tabindex="0"
    >
      <div 
        class="grid h-full" 
        style="
          grid-template-columns: 64px repeat({dates.length}, minmax(var(--col-width, 76px), 1fr)); 
          grid-template-rows: auto repeat({timeSlots.length}, minmax(36px, 1fr));
          width: 100%; 
          min-width: max-content;
        "
      >
        <!-- Grid Header: Times corner & Date chips -->
        <div class="sticky top-0 left-0 bg-white border-b border-r border-gray-100 py-3 z-20 text-center font-bold text-[10px] text-gray-400">
          시간
        </div>
        
        {#each dates as date}
          {@const isFolded = foldedDates[date.dateStr]}
          {@const isToday = new Date().toISOString().split('T')[0] === date.dateStr}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div 
            id="col-{date.dateStr}" 
            class="sticky top-0 border-b border-r border-gray-100 py-2.5 text-center flex flex-col items-center justify-center cursor-pointer transition-all z-10 
              {isToday ? 'bg-blue-50/50' : 'bg-white'} 
              {isFolded ? 'w-10 opacity-40 bg-gray-50' : 'min-w-[76px]'}"
            onclick={() => toggleFoldDate(date.dateStr)}
            title={isFolded ? '클릭하여 펼치기' : '클릭하여 접기'}
          >
            {#if isFolded}
              <div class="text-[9px] font-bold text-gray-400 transform rotate-90 my-1">
                {date.dateStr.slice(5)}
              </div>
              <div class="text-[8px] bg-gray-200 px-1 rounded text-gray-500 scale-75">
                접힘
              </div>
            {:else}
              <div class="text-[11px] font-bold {isToday ? 'text-blue-600' : 'text-gray-700'}">
                {date.label}
              </div>
              {#if date.isYesterday}
                <div class="text-[8px] bg-amber-100 text-amber-800 px-1 rounded font-semibold mt-0.5 scale-90">
                  어제
                </div>
              {:else if date.isPast}
                <div class="text-[8px] bg-gray-200 text-gray-500 px-1 rounded font-semibold mt-0.5 scale-90">
                  과거
                </div>
              {/if}
            {/if}
          </div>
        {/each}

        <!-- Grid Body Rows -->
        {#each timeSlots as slot, slotIdx}
          <!-- Left Time Column -->
          {@const startMin = timeStringToMinutes(room.time_start) + slot.startMinOffset}
          {@const endTimeLabel = minutesToTimeString(startMin + slot.durationMin)}
          <div 
            id="row-{slot.label}" 
            class="sticky left-0 bg-white border-r border-b border-gray-100 text-center flex items-center justify-center h-full py-1 z-10"
          >
            <div class="flex flex-col items-center justify-center text-[10px] leading-tight text-gray-400">
              <span class="font-bold text-gray-500">{slot.label}</span>
              <span class="text-[8px] text-gray-300 font-medium mt-0.5">~ {endTimeLabel}</span>
            </div>
          </div>

          <!-- Date Data Columns -->
          {#each dates as date}
            {@const isFolded = foldedDates[date.dateStr]}
            {@const cellData = getCellState(date, slot)}
            
            <!-- Grid Cell -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <div
              class="border-r border-b border-gray-100/60 relative h-full transition-colors select-none touch-none
                {isFolded ? 'bg-gray-50/50 w-10 pointer-events-none' : 'bg-white hover:bg-gray-50/40'}"
              data-date={date.dateStr}
              data-slot-idx={slotIdx}
              onpointerdown={() => startDrag(date.dateStr, slotIdx, cellData.isMeUnavailable)}
              role="gridcell"
              tabindex="-1"
            >
              {#if !isFolded}
                <!-- Render dynamic participant blocks inside cell -->
                {#each cellData.list as p, idx}
                  {@const isMe = p.id === mySession?.participant_id}
                  {@const isHighlighted = highlightedParticipantId === null || highlightedParticipantId === p.id}
                  {@const opacity = isMe 
                    ? (highlightedParticipantId === null ? 0.7 : (highlightedParticipantId === p.id ? 0.85 : 0.15))
                    : (highlightedParticipantId === null ? 0.35 : (highlightedParticipantId === p.id ? 0.7 : 0.12))}
                  <div
                    class="absolute rounded-md transition-all pointer-events-none {isMe ? 'border border-white/70 shadow-sm' : ''}"
                    style="
                      background-color: {p.color};
                      opacity: {opacity};
                      z-index: {isMe ? 10 : idx};
                      width: 82%;
                      height: 88%;
                      left: {isMe ? 'auto' : `${idx * 6}%`};
                      right: {isMe ? '4%' : 'auto'};
                      top: {`${idx * 3.5}%`};
                    "
                  ></div>
                {/each}
              {/if}
            </div>
          {/each}
        {/each}

      </div>
    </div>

    <!-- Footer: Participant chips & Highlights -->
    <footer class="bg-white border-t border-gray-100 p-4 rounded-t-3xl z-30 flex flex-col gap-2.5 w-full max-w-[480px] mx-auto shadow-lg shrink-0 relative">
      <!-- Floating [now] Button (Anchored right above the fixed footer) -->
      <button 
        class="absolute -top-16 right-4 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-bold text-[10px] uppercase flex items-center justify-center shadow-lg active:scale-90 transition-all z-35 cursor-pointer"
        onclick={scrollToNow} 
        aria-label="현재 시각으로 바로가기"
      >
        now
      </button>
      <div class="flex justify-between items-center text-xs font-bold text-gray-400 tracking-wider">
        <span>참여자 목록 ({participants.length}명)</span>
        {#if highlightedParticipantId !== null}
          <button 
            class="text-[10px] text-blue-600 font-semibold cursor-pointer"
            onclick={() => highlightedParticipantId = null}
          >
            강조 해제
          </button>
        {/if}
      </div>
      
      <div class="flex gap-2 overflow-x-auto pb-1.5 scrollbar-none">
        {#each participants as p}
          {@const isMe = p.id === mySession?.participant_id}
          {@const isHighlighted = highlightedParticipantId === p.id}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div 
            class="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100/70 border px-3 py-1.5 rounded-full text-xs font-semibold text-gray-600 cursor-pointer whitespace-nowrap transition-all
              {isHighlighted ? 'border-current' : 'border-gray-200/50'}"
            style="color: {isHighlighted ? p.color : 'inherit'}"
            onclick={() => {
              if (highlightedParticipantId === p.id) {
                highlightedParticipantId = null;
              } else {
                highlightedParticipantId = p.id;
              }
            }}
          >
            <span class="w-2.5 h-2.5 rounded-full" style="background-color: {p.color}"></span>
            <span>{p.nickname} {isMe ? '(나)' : ''}</span>
          </div>
        {/each}
      </div>
    </footer>

    <!-- Floating [now] Button has been moved inside gridContainer -->

    <!-- Bottom Sheet Settings Menu -->
    {#if showSettings}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div 
        class="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-50 flex items-end cursor-pointer" 
        onclick={() => showSettings = false}
        role="button"
        tabindex="-1"
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div 
          class="bg-white w-full max-h-[85vh] overflow-y-auto rounded-t-3xl p-6 flex flex-col gap-5 cursor-default transition-all shadow-xl max-w-[480px] mx-auto"
          onclick={e => e.stopPropagation()}
        >
          <div class="flex justify-between items-center">
            <h3 class="text-base font-extrabold text-gray-900">⚙️ 방 설정</h3>
            <button 
              class="w-7 h-7 rounded-full bg-gray-50 flex items-center justify-center text-xs text-gray-400 hover:bg-gray-100 cursor-pointer" 
              onclick={() => showSettings = false}
            >
              ✕
            </button>
          </div>

          <form onsubmit={handleUpdateSettings} class="space-y-4">
            <div>
              <label for="settings-title" class="block text-xs font-semibold text-gray-500 mb-1.5">모임 이름</label>
              <input 
                id="settings-title"
                type="text" 
                bind:value={editTitle} 
                class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all"
                required 
              />
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="settings-range" class="block text-xs font-semibold text-gray-500 mb-1.5">표시 기간</label>
                <select id="settings-range" bind:value={editRangeDays} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                  {#each Array.from({length: 30}, (_, i) => i + 1) as day}
                    <option value={day}>{day}일 동안</option>
                  {/each}
                </select>
              </div>

              <div>
                <label for="settings-policy" class="block text-xs font-semibold text-gray-500 mb-1.5">과거 일정 정책</label>
                <select id="settings-policy" bind:value={editPastPolicy} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                  <option value="today">오늘부터 표시</option>
                  <option value="yesterday">어제부터 표시</option>
                  <option value="7days">최근 7일 표시</option>
                </select>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="settings-start" class="block text-xs font-semibold text-gray-500 mb-1.5">시작 시간</label>
                <select id="settings-start" bind:value={editTimeStart} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                  {#each Array.from({length: 24}) as _, h}
                    {@const timeStr = `${String(h).padStart(2, '0')}:00`}
                    <option value={timeStr}>{timeStr}</option>
                  {/each}
                </select>
              </div>

              <div>
                <label for="settings-end" class="block text-xs font-semibold text-gray-500 mb-1.5">종료 시간</label>
                <select id="settings-end" bind:value={editTimeEnd} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                  {#each Array.from({length: 24}, (_, i) => i + 1) as h}
                    {@const timeStr = `${String(h).padStart(2, '0')}:00`}
                    <option value={timeStr}>{timeStr}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div>
              <label for="settings-unit" class="block text-xs font-semibold text-gray-500 mb-1.5">표시 시간 단위</label>
              <select id="settings-unit" bind:value={editDisplayUnit} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                <option value="15min">15분 단위</option>
                <option value="30min">30분 단위</option>
                <option value="1hour">1시간 단위</option>
                <option value="3hour">3시간 단위</option>
                <option value="6hour">6시간 단위</option>
                <option value="1day">하루 전체</option>
              </select>
              {#if !isUnitAllowed(editTimeStart, editTimeEnd, editDisplayUnit)}
                <div class="mt-2 text-[11px] leading-relaxed text-amber-600 bg-amber-50 border border-amber-200/50 p-2.5 rounded-lg">
                  ⚠️ 선택한 범위에는 이 단위를 설정할 수 없어, 저장 시 <strong>{getRecommendedUnit(editTimeStart, editTimeEnd) === '15min' ? '15분' : getRecommendedUnit(editTimeStart, editTimeEnd) === '30min' ? '30분' : '1시간'} 단위</strong>로 자동 조정됩니다.
                </div>
              {/if}
            </div>

            <button 
              type="submit" 
              class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
              disabled={isSavingSettings}
            >
              {#if isSavingSettings}저장 중...{:else}설정 저장{/if}
            </button>
          </form>

          <hr class="border-gray-100" />

          <!-- Member Management -->
          <div>
            <h4 class="text-xs font-bold text-gray-400 mb-2 tracking-wider">참여자 관리</h4>
            <div class="bg-gray-50 rounded-2xl p-3 border border-gray-100/60 max-h-36 overflow-y-auto space-y-2">
              {#each participants as p}
                <div class="flex justify-between items-center py-1">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full" style="background-color: {p.color}"></span>
                    <span class="text-xs font-semibold text-gray-700">{p.nickname} {p.id === mySession?.participant_id ? '(나)' : ''}</span>
                  </div>
                  {#if p.id !== mySession?.participant_id}
                    <button 
                      class="text-[10px] text-red-500 font-bold bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-full cursor-pointer"
                      onclick={() => kickParticipant(p.id)}
                    >
                      내보내기
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          </div>

          <div class="pt-2">
            <button 
              class="w-full py-3 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl text-sm font-bold transition-all cursor-pointer"
              onclick={deleteRoom}
            >
              모임 방 삭제하기
            </button>
          </div>
        </div>
      </div>
    {/if}

  {/if}
</div>

<style>
  /* Hide standard scrollbars for a clean iOS segment */
  .scrollbar-none::-webkit-scrollbar {
    display: none;
  }
  .scrollbar-none {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
