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
    getTodayStr,
    getEndDateFromDays,
    getDaysFromEndDate,
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
    host_id?: string | null;
  }

  interface Participant {
    id: string;
    nickname: string;
    color: string;
    last_active_at: string;
    last_modified_at?: string | null;
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
  let showHamburger = $state(false);
  let showParticipants = $state(false);
  let highlightedParticipantId = $state<string | null>(null);
  let gridContainer = $state<HTMLDivElement | null>(null);

  // Track folded dates (e.g. yesterday starts folded by default)
  let foldedDates = $state<Record<string, boolean>>({});

  // Nickname & Color edit states
  let isEditingNickname = $state(false);
  let editNicknameVal = $state('');

  const vibrantColors = [
    'hsl(0, 80%, 55%)',   // Red
    'hsl(30, 80%, 55%)',  // Orange
    'hsl(120, 80%, 45%)', // Green
    'hsl(200, 80%, 55%)', // Ocean Blue
    'hsl(270, 80%, 55%)', // Purple
    'hsl(320, 80%, 55%)', // Pink
    'hsl(160, 80%, 45%)', // Teal
    'hsl(45, 90%, 50%)'   // Yellow Gold
  ];

  // Host check (derived)
  const isHost = $derived(room && mySession && (!room.host_id || room.host_id === mySession.participant_id));

  // Settings states
  let editTitle = $state('');
  let editEndDate = $state('');
  let editRangeDays = $derived(getDaysFromEndDate(editEndDate));
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
  let activePingInterval: any = null;

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
      editEndDate = getEndDateFromDays(roomData.range_days);
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
      activePingInterval = setInterval(updateActiveStatus, 15000);
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
    if (activePingInterval) {
      clearInterval(activePingInterval);
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
    if (isHeaderDragging && gridContainer) {
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 5) {
        hasDragged = true;
      }
      gridContainer.scrollLeft = dragScrollLeft - dx;
      return;
    }

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

        // Update last_modified_at for the participant
        await db
          .from('participants')
          .update({ last_modified_at: new Date().toISOString() })
          .eq('id', mySession!.participant_id);
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

        // Update last_modified_at for the participant
        await db
          .from('participants')
          .update({ last_modified_at: new Date().toISOString() })
          .eq('id', mySession.participant_id);
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
    if (hasDragged) {
      hasDragged = false;
      return;
    }
    foldedDates[dateStr] = !foldedDates[dateStr];
  }

  // Update participant profile
  async function updateMyNickname() {
    if (!mySession || !editNicknameVal.trim() || !room) return;
    try {
      const newNick = editNicknameVal.trim();
      const { error } = await db
        .from('participants')
        .update({ nickname: newNick })
        .eq('id', mySession.participant_id);

      if (error) throw error;

      mySession.nickname = newNick;
      localStorage.setItem(`room_session_${room.id}`, JSON.stringify(mySession));
      isEditingNickname = false;
    } catch (err) {
      alert('닉네임 수정 실패: ' + (err as any).message);
    }
  }

  async function updateMyColor(color: string) {
    if (!mySession || !room) return;
    try {
      const { error } = await db
        .from('participants')
        .update({ color })
        .eq('id', mySession.participant_id);

      if (error) throw error;

      mySession.color = color;
      localStorage.setItem(`room_session_${room.id}`, JSON.stringify(mySession));
    } catch (err) {
      alert('색상 수정 실패: ' + (err as any).message);
    }
  }

  // Timeago helper
  function timeAgo(dateInput: string | Date | undefined): string {
    if (!dateInput) return '기록 없음';
    const date = new Date(dateInput);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 15) return '방금 전';
    if (diffSec < 60) return `${diffSec}초 전`;
    if (diffMin < 60) return `${diffMin}분 전`;
    if (diffHr < 24) return `${diffHr}시간 전`;
    return `${diffDay}일 전`;
  }

  // Participant status mapping
  function getParticipantStatus(lastActiveAt: string): { status: 'online' | 'idle' | 'offline'; colorClass: string; text: string } {
    const activeTime = new Date(lastActiveAt).getTime();
    const nowTime = new Date().getTime();
    const diffSeconds = (nowTime - activeTime) / 1000;

    if (diffSeconds <= 45) {
      return { status: 'online', colorClass: 'bg-emerald-500', text: '온라인' };
    } else if (diffSeconds <= 180) {
      return { status: 'idle', colorClass: 'bg-amber-500', text: '자리비움' };
    } else {
      return { status: 'offline', colorClass: 'bg-gray-400', text: '오프라인' };
    }
  }

  // Exit Room handler
  async function handleExitRoom() {
    if (!mySession || !room) return;

    const deleteData = confirm('방에서 나가시겠습니까?\n확인을 누르시면 등록한 일정 데이터가 모두 삭제됩니다. 취소를 누르시면 데이터는 유지하고 화면만 나갑니다.');

    try {
      if (deleteData) {
        const { error } = await db
          .from('participants')
          .delete()
          .eq('id', mySession.participant_id);
        if (error) throw error;
      }

      localStorage.removeItem(`room_session_${room.id}`);
      goto('/');
    } catch (err) {
      alert('나가기 처리 중 에러가 발생했습니다: ' + (err as any).message);
    }
  }

  // Header Drag to Scroll states & Day Jump functions
  let isHeaderDragging = $state(false);
  let dragStartX = 0;
  let dragScrollLeft = 0;
  let hasDragged = $state(false);

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    const headerCell = target.closest('[id^="col-"]') || (target.closest('.sticky') && target.closest('.sticky')?.textContent?.includes('시간'));

    if (headerCell && gridContainer) {
      isHeaderDragging = true;
      hasDragged = false;
      dragStartX = e.clientX;
      dragScrollLeft = gridContainer.scrollLeft;
      e.preventDefault();
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (isHeaderDragging) {
      isHeaderDragging = false;
    }
    stopDrag();
  }

  function scrollOneDayLeft() {
    if (!gridContainer) return;
    const firstCol = gridContainer.querySelector('[id^="col-"]');
    const colWidth = firstCol ? firstCol.clientWidth : 76;
    gridContainer.scrollBy({
      left: -colWidth,
      behavior: 'smooth'
    });
  }

  function scrollOneDayRight() {
    if (!gridContainer) return;
    const firstCol = gridContainer.querySelector('[id^="col-"]');
    const colWidth = firstCol ? firstCol.clientWidth : 76;
    gridContainer.scrollBy({
      left: colWidth,
      behavior: 'smooth'
    });
  }
</script>

<svelte:window onpointermove={handlePointerMove} onpointerup={handlePointerUp} />

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
    <header class="bg-white/80 backdrop-blur-md border-b border-gray-100 px-4 py-2 sticky top-0 z-40 flex items-center justify-between shrink-0 h-14">
      <!-- 좌측: 설정(방장전용) & 햄버거 버튼 -->
      <div class="flex items-center gap-1.5 w-[30%] justify-start">
        {#if isHost}
          <button
            class="w-8 h-8 rounded-full bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-sm border border-gray-200/50 cursor-pointer active:scale-95 transition-all"
            onclick={() => showSettings = true}
            aria-label="방 설정 열기"
            title="방 설정"
          >
            ⚙️
          </button>
        {/if}
        <button
          class="w-8 h-8 rounded-full bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-sm border border-gray-200/50 cursor-pointer active:scale-95 transition-all"
          onclick={() => showHamburger = true}
          aria-label="메뉴 열기"
          title="메뉴"
        >
          ☰
        </button>
      </div>

      <!-- 중앙: 방 이름 -->
      <div class="w-[40%] text-center">
        <h1 class="text-sm font-extrabold text-gray-900 overflow-hidden text-ellipsis whitespace-nowrap">
          {room.title}
        </h1>
      </div>

      <!-- 우측: 참여자 버튼 & 현재 표시 날짜 범위 -->
      <div class="flex flex-col items-end justify-center w-[30%] gap-0.5">
        <button
          class="w-8 h-8 rounded-full bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-sm border border-gray-200/50 cursor-pointer active:scale-95 transition-all"
          onclick={() => {
            showParticipants = true;
            editNicknameVal = mySession?.nickname || '';
            isEditingNickname = false;
          }}
          aria-label="참여자 목록 보기"
          title="참여자 목록"
        >
          👥
        </button>
        <span class="text-[8px] text-gray-400 font-bold tracking-tight whitespace-nowrap">
          {dates.length > 0 ? `${dates[0].label} ~ ${dates[dates.length - 1].label}` : ''}
        </span>
      </div>
    </header>

    <!-- Main Scheduler Grid container wrapper -->
    <div class="flex-1 relative overflow-hidden flex flex-col">
      <!-- 좌측 하루 이동 버튼 -->
      <button
        onclick={scrollOneDayLeft}
        class="absolute left-16 top-[7px] z-40 w-7 h-7 rounded-full bg-white/95 shadow-sm border border-gray-200/50 flex items-center justify-center text-xs font-bold text-gray-500 hover:bg-white active:scale-90 transition-all cursor-pointer select-none"
        aria-label="하루 왼쪽으로 이동"
      >
        &lt;
      </button>

      <!-- 우측 하루 이동 버튼 -->
      <button
        onclick={scrollOneDayRight}
        class="absolute right-3 top-[7px] z-40 w-7 h-7 rounded-full bg-white/95 shadow-sm border border-gray-200/50 flex items-center justify-center text-xs font-bold text-gray-500 hover:bg-white active:scale-90 transition-all cursor-pointer select-none"
        aria-label="하루 오른쪽으로 이동"
      >
        &gt;
      </button>

      <div
        bind:this={gridContainer}
        class="flex-1 overflow-auto relative select-none touch-none"
        onpointerdown={handlePointerDown}
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
        <div class="sticky top-0 left-0 bg-white border-b border-r border-gray-100 py-3 z-30 text-center font-bold text-[10px] text-gray-400">
          시간
        </div>

        {#each dates as date}
          {@const isFolded = foldedDates[date.dateStr]}
          {@const isToday = new Date().toISOString().split('T')[0] === date.dateStr}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            id="col-{date.dateStr}"
            class="sticky top-0 border-b border-r border-gray-100 py-2.5 text-center flex flex-col items-center justify-center cursor-pointer transition-all z-20
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
            class="sticky left-0 bg-white border-r border-b border-gray-100 text-center flex items-center justify-center h-full py-1 z-20"
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
              class="border-r border-b border-gray-100/60 relative z-0 h-full transition-colors select-none touch-none
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
  </div>

    <!-- Floating [now] Button (FAB anchored at the bottom right) -->
    <button
      class="fixed bottom-6 right-6 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-bold text-[10px] uppercase flex items-center justify-center shadow-2xl active:scale-90 transition-all z-30 cursor-pointer"
      onclick={scrollToNow}
      aria-label="현재 시각으로 바로가기"
    >
      now
    </button>

    <!-- Bottom Sheet Settings Menu (Host Only) -->
    {#if showSettings && isHost}
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
                <label for="settings-end-date" class="block text-xs font-semibold text-gray-500 mb-1.5">
                  마감 날짜 <span class="text-blue-600 font-normal">({editRangeDays}일 동안)</span>
                </label>
                <input
                  id="settings-end-date"
                  type="date"
                  bind:value={editEndDate}
                  min={getTodayStr()}
                  class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all"
                  required
                />
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

          <div>
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

    <!-- Bottom Sheet Hamburger Menu -->
    {#if showHamburger}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-50 flex items-end cursor-pointer"
        onclick={() => showHamburger = false}
        role="button"
        tabindex="-1"
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="bg-white w-full rounded-t-3xl p-6 flex flex-col gap-5 cursor-default transition-all shadow-xl max-w-[480px] mx-auto pb-8"
          onclick={e => e.stopPropagation()}
        >
          <div class="flex justify-between items-center">
            <h3 class="text-base font-extrabold text-gray-900">☰ 메뉴</h3>
            <button
              class="w-7 h-7 rounded-full bg-gray-50 flex items-center justify-center text-xs text-gray-400 hover:bg-gray-100 cursor-pointer"
              onclick={() => showHamburger = false}
            >
              ✕
            </button>
          </div>

          <div class="flex flex-col gap-3">
            <button
              class="w-full py-3.5 bg-gray-50 hover:bg-gray-100 text-gray-800 rounded-2xl text-sm font-semibold transition-all text-left px-4 flex items-center justify-between"
              onclick={() => {
                showHamburger = false;
                showParticipants = true;
                editNicknameVal = mySession?.nickname || '';
                isEditingNickname = false;
              }}
            >
              <span>👥 참여자 목록</span>
              <span class="text-xs text-gray-400 font-normal">{participants.length}명 참여 중 &gt;</span>
            </button>

            <button
              class="w-full py-3.5 bg-gray-50 hover:bg-gray-100 text-gray-800 rounded-2xl text-sm font-semibold transition-all text-left px-4 flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={() => {
                showHamburger = false;
                showSettings = true;
              }}
              disabled={!isHost}
            >
              <div class="flex items-center gap-1">
                <span>⚙️ 방 설정</span>
                {#if !isHost}
                  <span class="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded font-normal">방장 전용</span>
                {/if}
              </div>
              <span class="text-xs text-gray-400 font-normal">&gt;</span>
            </button>

            <button
              class="w-full py-3.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-2xl text-sm font-semibold transition-all text-left px-4 flex items-center justify-between"
              onclick={() => {
                showHamburger = false;
                handleExitRoom();
              }}
            >
              <span>🚪 나가기</span>
              <span class="text-xs text-red-400 font-normal">&gt;</span>
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Fullscreen Bottom Sheet: Participants & Profile Edit -->
    {#if showParticipants}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-50 flex items-end cursor-pointer"
        onclick={() => showParticipants = false}
        role="button"
        tabindex="-1"
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="bg-white w-full max-h-[85vh] overflow-y-auto rounded-t-3xl p-6 flex flex-col gap-5 cursor-default transition-all shadow-xl max-w-[480px] mx-auto pb-8"
          onclick={e => e.stopPropagation()}
        >
          <div class="flex justify-between items-center">
            <h3 class="text-base font-extrabold text-gray-900">👥 참여자 목록</h3>
            <button
              class="w-7 h-7 rounded-full bg-gray-50 flex items-center justify-center text-xs text-gray-400 hover:bg-gray-100 cursor-pointer"
              onclick={() => showParticipants = false}
            >
              ✕
            </button>
          </div>

          <!-- 내 프로필 설정 (닉네임 / 색상 인라인 수정) -->
          {#if mySession}
            {@const myPart = participants.find(p => p.id === mySession!.participant_id)}
            <div class="bg-blue-50/40 border border-blue-100/50 rounded-2xl p-4 flex flex-col gap-3">
              <span class="text-[10px] font-bold text-blue-600 tracking-wider">내 프로필 설정</span>

              <div class="flex items-center justify-between gap-3">
                <!-- 인라인 닉네임 편집 -->
                <div class="flex-1 flex items-center gap-2">
                  {#if isEditingNickname}
                    <form onsubmit={e => { e.preventDefault(); updateMyNickname(); }} class="flex items-center gap-1.5 w-full">
                      <input
                        type="text"
                        bind:value={editNicknameVal}
                        class="flex-1 bg-white border border-gray-200 rounded-lg px-2.5 py-1 text-xs text-gray-900 focus:outline-none focus:border-blue-500"
                        required
                        maxlength="15"
                      />
                      <button type="submit" class="bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg">저장</button>
                      <button type="button" class="bg-gray-100 text-gray-500 text-[10px] px-2.5 py-1.5 rounded-lg" onclick={() => isEditingNickname = false}>취소</button>
                    </form>
                  {:else}
                    <span class="text-sm font-bold text-gray-800">{myPart?.nickname || mySession.nickname}</span>
                    <button
                      class="text-[10px] text-blue-600 font-semibold hover:underline"
                      onclick={() => {
                        isEditingNickname = true;
                        editNicknameVal = myPart?.nickname || mySession!.nickname;
                      }}
                    >
                      ✏️ 수정
                    </button>
                  {/if}
                </div>

                <!-- 현재 내 색상 표시 -->
                <div class="flex items-center gap-1.5">
                  <span class="text-[11px] text-gray-400 font-medium">내 색상</span>
                  <span class="w-5 h-5 rounded-full border border-white/80 shadow-sm" style="background-color: {myPart?.color || mySession.color}"></span>
                </div>
              </div>

              <!-- 인라인 색상 팔레트 -->
              <div class="flex flex-col gap-1.5 mt-1">
                <span class="text-[10px] text-gray-400 font-medium">색상 변경</span>
                <div class="flex gap-2 flex-wrap">
                  {#each vibrantColors as color}
                    <button
                      class="w-6 h-6 rounded-full border-2 transition-all active:scale-90
                        {(myPart?.color || mySession.color) === color ? 'border-blue-600 scale-110 shadow-sm' : 'border-transparent'}"
                      style="background-color: {color}"
                      onclick={() => updateMyColor(color)}
                      aria-label="색상 선택"
                    ></button>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          <!-- 참여자 리스트 표시 -->
          <div class="flex flex-col gap-2 max-h-60 overflow-y-auto">
            <span class="text-[10px] font-bold text-gray-400 tracking-wider">참여자 현황 ({participants.length}명)</span>

            {#each participants as p}
              {@const isMe = p.id === mySession?.participant_id}
              {@const activeInfo = getParticipantStatus(p.last_active_at)}
              <div class="flex justify-between items-center py-2 border-b border-gray-50 last:border-b-0">
                <div class="flex items-center gap-2">
                  <!-- 접속 상태 🟢/🟡/⚫ 지시등 -->
                  <span
                    class="w-2 h-2 rounded-full {activeInfo.colorClass}"
                    title={activeInfo.text}
                  ></span>

                  <span class="w-3 h-3 rounded-full" style="background-color: {p.color}"></span>
                  <span class="text-xs font-semibold text-gray-700">{p.nickname} {isMe ? '(나)' : ''}</span>
                  {#if room.host_id === p.id}
                    <span class="text-[9px] text-blue-600 bg-blue-50 px-1 py-0.5 rounded font-bold">방장</span>
                  {/if}
                </div>

                <div class="flex items-center gap-2">
                  <div class="text-right">
                    <div class="text-[9px] text-gray-300 font-medium">마지막 수정</div>
                    <div class="text-[10px] text-gray-500 font-bold">{p.last_modified_at ? timeAgo(p.last_modified_at) : '수정 없음'}</div>
                  </div>

                  <!-- 내보내기 버튼 (방장 전용 및 타인 대상) -->
                  {#if isHost && !isMe}
                    <button
                      class="text-[9px] text-red-500 font-bold bg-red-50 hover:bg-red-100 px-2 py-1 rounded-lg ml-1"
                      onclick={() => kickParticipant(p.id)}
                    >
                      내보내기
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          <hr class="border-gray-100" />

          <!-- 방 공유 세션 (초대 코드 & 링크 복사) -->
          <div class="bg-gray-50 rounded-2xl p-4 flex flex-col gap-2.5">
            <span class="text-[10px] font-bold text-gray-400 tracking-wider">모임 공유 정보</span>

            <div class="flex items-center justify-between text-xs text-gray-700 font-semibold bg-white px-3 py-2 rounded-xl border border-gray-100">
              <span class="text-gray-400 font-medium select-none">초대 코드</span>
              <span class="font-mono text-[11px] select-all">{roomId}</span>
            </div>

            <button
              class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all active:scale-[0.98]"
              onclick={copyInviteLink}
            >
              🔗 초대 링크 복사
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
